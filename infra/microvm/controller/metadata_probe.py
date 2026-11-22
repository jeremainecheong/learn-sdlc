"""Guest-only diagnostic source; emits status and field names, never values."""
import http.client
import json
import os
import re

CREDENTIAL_FIELDS = {'AccessKeyId', 'SecretAccessKey', 'SessionToken', 'Token',
                     'accessKeyId', 'secretAccessKey', 'sessionToken'}
observations = []


def request(label, method, path, headers=None):
    connection = http.client.HTTPConnection('169.254.169.254', 80, timeout=2)
    try:
        connection.request(method, path, headers=headers or {})
        response = connection.getresponse()
        raw = response.read(65537)
        text = raw.decode('utf-8', errors='replace')
        fields = sorted(name for name in CREDENTIAL_FIELDS if re.search(r'"' + name + r'"\s*:', text))
        observations.append({'label':label,'status':response.status,
                             'credentialFieldNames':fields,'responseBounded':len(raw)<=65536})
        # Raw metadata lives only in this VM process and is never printed/saved.
        return response.status, text
    except (OSError, http.client.HTTPException) as error:
        observations.append({'label':label,'status':None,'error':type(error).__name__,
                             'credentialFieldNames':[]})
        return None, ''
    finally:
        connection.close()


def credentials(label, headers=None):
    status, text = request(label, 'GET', '/latest/meta-data/iam/security-credentials/', headers)
    # Follow at most one syntactically valid role name without exposing it.
    roles = text.strip().splitlines() if status == 200 else []
    if roles and re.fullmatch(r'[A-Za-z0-9_+=,.@-]{1,128}', roles[0]):
        request(label+'-role', 'GET', '/latest/meta-data/iam/security-credentials/'+roles[0], headers)


credentials('imdsv1-credentials')
request('imdsv1-role-info', 'GET', '/latest/meta-data/iam/info')
status, token = request('imdsv2-token', 'PUT', '/latest/api/token',
                        {'X-aws-ec2-metadata-token-ttl-seconds':'60'})
if status == 200 and 0 < len(token) < 4096 and '\r' not in token and '\n' not in token:
    credentials('imdsv2-credentials', {'X-aws-ec2-metadata-token':token})
    request('imdsv2-role-info', 'GET', '/latest/meta-data/iam/info',
            {'X-aws-ec2-metadata-token':token})
secret_env = {'AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY','AWS_SESSION_TOKEN',
              'AWS_CONTAINER_CREDENTIALS_FULL_URI','AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
              'AWS_WEB_IDENTITY_TOKEN_FILE'}
checks = {'credential_fields_absent':not any(row['credentialFieldNames'] for row in observations),
          'credential_environment_absent':not bool(secret_env & set(os.environ)),
          'metadata_responses_bounded':all(row.get('responseBounded',True) for row in observations)}
print('MICROVM_METADATA_RESULT='+json.dumps({'checks':checks,'observations':observations},sort_keys=True))
assert all(checks.values()), 'metadata credential boundary failed; values withheld'
print('METADATA_CREDENTIAL_FIELDS_ABSENT')
