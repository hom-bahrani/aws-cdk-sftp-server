import {
  Stack,
  StackProps,
  CfnOutput,
  RemovalPolicy,
  Duration,
  CustomResource,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { 
  IHostedZone,
  HostedZone,
  CnameRecord
} from 'aws-cdk-lib/aws-route53';
import {
  Certificate,
  ICertificate,
  CertificateValidation
} from 'aws-cdk-lib/aws-certificatemanager';
import {
  Vpc,
  SecurityGroup,
  Peer,
  Port,
  CfnEIP,
} from 'aws-cdk-lib/aws-ec2';
import {
  Role,
  PolicyStatement,
  ServicePrincipal
} from 'aws-cdk-lib/aws-iam';
import {
  CfnServer,
  CfnUser
} from 'aws-cdk-lib/aws-transfer';
import {
  Bucket,
  BlockPublicAccess,
  EventType
} from 'aws-cdk-lib/aws-s3';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import {
  Function,
  Runtime,
  Code
} from 'aws-cdk-lib/aws-lambda';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Provider } from 'aws-cdk-lib/custom-resources';
import {
  EmailSubscription,
  LambdaSubscription
} from 'aws-cdk-lib/aws-sns-subscriptions';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { SnsDestination } from 'aws-cdk-lib/aws-s3-notifications';
import { options } from './config';

export class AwsCdkSftpServerStack extends Stack {
  zone?: IHostedZone;
  certificate?: ICertificate | Certificate;


  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    
    const {
      vpcAttr,
      sftpAttr,
      customHostKey,
      customHostname,
      users,
      notificationEmails,
    } = options;

    const { customVpcId } = vpcAttr;
    
    const {
      allowCidrs,
      moveToArchive
    } = sftpAttr;
    
    const {
      useCustomHostname,
      dnsAttr,
      sftpHostname,
      certificateArn,
    } = customHostname;
    
    const {
      useCustomKey,
      hostKeySecretArn,
      hostKeyVersion
    } = customHostKey;

    const vpc = (customVpcId) ?
      Vpc.fromLookup(this, 'vpc', { vpcId: customVpcId })
        : Vpc.fromLookup(this, 'vpc', { isDefault: true });
    
    const { vpcId, vpcCidrBlock } = vpc;

    const subnets = vpc.publicSubnets;
    
    if (!subnets.length) {
      throw new Error('One public subnet is required');
    }

    const subnetIds = subnets.map((subnet) => subnet.subnetId);

    if (useCustomHostname) {
      const { zoneName, hostedZoneId } = dnsAttr;

      if (!zoneName || !hostedZoneId || !sftpHostname) {
        throw new Error('zoneName, hostedZoneId, sftpHostname are required to use a custom hostname');
      }

      this.zone = HostedZone.fromHostedZoneAttributes(this, 'zone', dnsAttr);

      this.certificate = (certificateArn) ?
        Certificate.fromCertificateArn(this, 'cert', certificateArn)
          : new Certificate(this, 'cert', {
          domainName: `*.${zoneName}`,
          validation: CertificateValidation.fromDns(this.zone),
      });
    }

    const loggingRole = new Role(this, 'loggingRole', {
      assumedBy: new ServicePrincipal('transfer.amazonaws.com'),
      description: 'Logging Role for the SFTP Server',
    });

    loggingRole.addToPrincipalPolicy(new PolicyStatement({
      sid: 'Logs',
      actions: [
        'logs:CreateLogStream',
        'logs:DescribeLogStreams',
        'logs:CreateLogGroup',
        'logs:PutLogEvents',
      ],
      resources: ['*'],
    }));


    const sg = new SecurityGroup(this, 'sg', {
      description: 'SFTP Server Sg',
      vpc,
      allowAllOutbound: true,
    });

    if (allowCidrs.length) {
      allowCidrs.forEach((cidr) => sg.addIngressRule(Peer.ipv4(cidr), Port.tcp(22), 'allow external SFTP access'));
      sg.addIngressRule(Peer.ipv4(vpcCidrBlock), Port.tcp(22), 'allow internal SFTP access');
    } else {
      sg.addIngressRule(Peer.anyIpv4(), Port.tcp(22), 'allow public SFTP access');
    }

    const addressAllocationIds = subnetIds.map((sid) => (new CfnEIP(this, `eip${sid}`)).attrAllocationId);

    const server = new CfnServer(this, 'sftpServer', {
      domain: 'S3',
      endpointType: 'VPC',
      identityProviderType: 'SERVICE_MANAGED',
      loggingRole: loggingRole.roleArn,
      protocols: ['SFTP'],
      endpointDetails: {
        addressAllocationIds,
        vpcId,
        subnetIds,
        securityGroupIds: [sg.securityGroupId],
      },
      certificate: this.certificate?.certificateArn,
    });

    const serverId = server.attrServerId;
    const domainName = `${serverId}.server.transfer.${this.region}.amazonaws.com`;
    new CfnOutput(this, 'domainName', {
      description: 'Server endpoint hostname',
      value: domainName,
    });

    if (useCustomHostname && this.zone) {
      const sftpDomainName = `${sftpHostname}.${this.zone.zoneName}`;
      new CnameRecord(this, 'record', {
        recordName: sftpDomainName,
        domainName,
        zone: this.zone,
      });
      
      new CfnOutput(this, 'customHostname', {
        description: 'Custom server hostname',
        value: sftpDomainName,
      });
    }

    const sftpBucket = new Bucket(this, 'sftpBucket', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    if (useCustomKey) {
      if (!hostKeySecretArn) {
        throw new Error('hostKeySecretArn must be provided when importing a custom host key');
      }

      const keySecret = Secret.fromSecretCompleteArn(this, 'keySecret', hostKeySecretArn);

      // Lambda function for custom resource. We cannot use the 
      // CDK AWSCustomResource provider as we need to manipulate
      // the key from Secrets Manager
      const hostKeyFnc = new Function(this, 'hostKeyFnc', {
        description: 'Update SFTP Host Key',
        runtime: Runtime.NODEJS_14_X,
        handler: 'index.handler',
        timeout: Duration.seconds(5),
        code: Code.fromAsset(`lambda/host-key`),
        logRetention: RetentionDays.ONE_WEEK,
      });

      keySecret.grantRead(hostKeyFnc);
      hostKeyFnc.addToRolePolicy(new PolicyStatement({
        actions: ['transfer:UpdateServer'],
        resources: [`arn:aws:transfer:${this.region}:${this.account}:server/${serverId}`],
      }));

      const hostKeyProvider = new Provider(this, 'hostKeyProvider', {
        onEventHandler: hostKeyFnc,
        logRetention: RetentionDays.ONE_WEEK,
      });

      new CustomResource(this, 'customHostKey', {
        serviceToken: hostKeyProvider.serviceToken,
        properties: {
          serverId,
          hostKeySecretArn,
          hostKeyVersion, 
        },
      });
    }

    const userRole = new Role(this, 'userRole', {
      assumedBy: new ServicePrincipal('transfer.amazonaws.com'),
      description: 'SFTP standard user role',
    });

    userRole.addToPrincipalPolicy(new PolicyStatement({
      sid: 'List',
      actions: ['s3:ListBucket'],
      resources: ['*'],
    }));

    userRole.addToPrincipalPolicy(new PolicyStatement({
      sid: 'UserObjects',
      actions: [
        's3:PutObject',
        's3:GetObject',
        's3:GetObjectVersion',
      ],
      resources: [`${sftpBucket.bucketArn}/*`],
    }));

    users.forEach((user: { userName: string; publicKey: string; }, i) => {
      const { userName, publicKey } = user;
      new CfnUser(this, `user${i + 1}`, {
        role: userRole.roleArn,
        serverId,
        userName,
        homeDirectory: `/${sftpBucket.bucketName}/home/${userName}`,
        sshPublicKeys: [publicKey],
        policy: '{ \n\
            "Version": "2012-10-17", \n\
                    "Statement": [ \n\
                        { \n\
                            "Sid": "AllowListingOfUserFolder", \n\
                            "Effect": "Allow", \n\
                            "Action": "s3:ListBucket", \n\
                            "Resource": "arn:aws:s3:::${transfer:HomeBucket}", \n\
                            "Condition": { \n\
                                "StringLike": { \n\
                                    "s3:prefix": [ \n\
                                        "home/${transfer:UserName}/*", \n\
                                        "home/${transfer:UserName}" \n\
                                    ] \n\
                                } \n\
                            } \n\
                        }, \n\
                        { \n\
                            "Sid": "HomeDirObjectAccess", \n\
                            "Effect": "Allow", \n\
                            "Action": [ \n\
                                "s3:PutObject", \n\
                                "s3:GetObject", \n\
                                "s3:GetObjectVersion" \n\
                            ], \
                            "Resource": "arn:aws:s3:::${transfer:HomeDirectory}*" \n\
                        } \n\
                    ] \n\
            } \n\
        ',
      });
    });

    const notifTopic = new Topic(this, 'notifTopic', { displayName: 'AWS Transfer Notifictions' });

    sftpBucket.addEventNotification(EventType.OBJECT_CREATED_PUT, new SnsDestination(notifTopic));
    
    notificationEmails.forEach((email: string) => {
      notifTopic.addSubscription(new EmailSubscription(email));
    });

    if (moveToArchive) {
      const archiveBucket = new Bucket(this, 'archiveBucket', {
        blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
        removalPolicy: RemovalPolicy.DESTROY,
        autoDeleteObjects: true,
      });

      const archiveFnc = new Function(this, 'archiveFnc', {
        description: 'Lambda SFTP Archive Function',
        runtime: Runtime.NODEJS_14_X,
        handler: 'index.handler',
        timeout: Duration.seconds(5),
        code: Code.fromAsset(`lambda/archive`),
        environment: {
          ARCHIVE_BUCKET: archiveBucket.bucketName,
        },
      });
      archiveBucket.grantPut(archiveFnc);
      sftpBucket.grantReadWrite(archiveFnc);

      notifTopic.addSubscription(new LambdaSubscription(archiveFnc));
    }

    
  }
}
