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
import { Vpc } from 'aws-cdk-lib/aws-ec2';

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




    
  }
}
