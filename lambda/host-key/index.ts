import * as AWS from 'aws-sdk';

const transfer = new AWS.Transfer();
const sm = new AWS.SecretsManager();

exports.handler = async (event:any) => {
  console.log('Event: ', JSON.stringify(event));
  try {
    const {
      RequestType, PhysicalResourceId, ResourceProperties, RequestId,
    } = event;
    const { serverId = '', hostKeySecretArn = '', hostKeyVersion = '' } = ResourceProperties;
    const validTypes = ['Create', 'Update', 'Delete'];
    if (!validTypes.includes(RequestType)) { throw new Error('Invalid RequestType'); }

    if (RequestType === 'Delete') {
      console.log('Delete request received - ignoring it');
      return {
        PhysicalResourceId,
      };
    }

    if (!serverId) { throw new Error('Missing serverId'); }
    if (!hostKeySecretArn) { throw new Error('Missing hostKeySecretArn'); }

    console.log('Getting and converting the key...');
    const b64 = Buffer.from((await sm.getSecretValue({
      SecretId: hostKeySecretArn,
    }).promise()).SecretString, 'base64');
    const key = b64.toString('ascii');

    console.log('Updating the server...');
    const { ServerId } = await transfer.updateServer({
      ServerId: serverId,
      HostKey: key,
    }).promise();

    console.log(`Updated host key for server: ${ServerId} to version: ${hostKeyVersion}`);

    return {
      PhysicalResourceId: (RequestType === 'Create') ? RequestId : PhysicalResourceId,
    };
  } catch (err: any) {
    err.message = (err.message) || 'Handler error';
    console.log('Error caught: ', err);
    throw err;
  }
};
