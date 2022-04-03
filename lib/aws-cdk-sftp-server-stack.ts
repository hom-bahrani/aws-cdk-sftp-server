import {
  Stack,
  StackProps,
  CfnOutput,
  RemovalPolicy
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
import { CfnServer } from 'aws-cdk-lib/aws-transfer';
import {
  Bucket,
  BlockPublicAccess
} from 'aws-cdk-lib/aws-s3';



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

    
  }
}
