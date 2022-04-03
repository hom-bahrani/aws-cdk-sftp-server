import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { IHostedZone } from 'aws-cdk-lib/aws-route53';
import { Certificate, ICertificate } from 'aws-cdk-lib/aws-certificatemanager';

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
    
  }
}
