import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { 
  IHostedZone,
  HostedZone
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

    
  }
}
