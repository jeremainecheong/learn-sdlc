"""Opt-in, two-VM deployed-image verification. Never used by the host service."""
import argparse
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import threading
import time
import uuid

from bridge import Bridge, Config
from cloud import PREVIEW_REGION, AwsCli, GuestHttp, Unavailable, encode
from registry import Registry

ROOT = Path(__file__).resolve().parents[3]
# Defaults for the two options that have one (see main): the AWS CLI on PATH, and the MicroVM image name the
# Terraform module gives a deployment with its default name. The operator's profile, the deployment's outputs file
# and the folder for the run's private evidence have no default: each belongs to one operator and one deployment.
AWS_BIN = 'aws'
IMAGE_NAME = 'learnsdlc-preview-tasktrackr'


def private_write(path, value):
    path.write_bytes(encode(value))
    path.chmod(0o600)


class OperatorVerificationCli(AwsCli):
    """Explicit approved operator identity, isolated from production AwsCli."""
    def __init__(self, folder, binary, profile, region=PREVIEW_REGION):
        super().__init__(str(binary), region, str(folder))
        self.profile = profile
        self.folder = folder
        self.events = []
        self.counter = 0
        self.clients = set()
        self.lock = threading.Lock()

    def call(self, operation, payload, timeout=20):
        if operation not in {'run-microvm', 'get-microvm', 'terminate-microvm',
                             'create-microvm-auth-token', 'get-caller-identity'}:
            raise ValueError('verification operation outside scope')
        with self.lock:
            if operation == 'run-microvm':
                token = payload['clientToken']
                if token not in self.clients and len(self.clients) >= 2:
                    raise Unavailable('two-instance verification limit reached')
                self.clients.add(token)
                if (payload['maximumDurationInSeconds'] != 180 or payload['imageVersion'] != '1.0'
                        or 'executionRoleArn' in payload):
                    raise Unavailable('verification launch exceeds authorization')
            self.counter += 1
            sequence = self.counter
        request_path = self.folder / f'{sequence:03d}-{operation}-input.json'
        private_write(request_path, payload)
        output_path = self.folder / f'{sequence:03d}-{operation}-output.json'
        error_path = self.folder / f'{sequence:03d}-{operation}-stderr.txt'
        env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': str(Path.home()),
               'LANG': 'C.UTF-8', 'AWS_REGION': self.region, 'AWS_DEFAULT_REGION': self.region,
               'AWS_IGNORE_CONFIGURED_ENDPOINT_URLS': 'true', 'AWS_MAX_ATTEMPTS': '1',
               'AWS_PAGER': '', 'AWS_CLI_AUTO_PROMPT': 'off', 'AWS_EC2_METADATA_DISABLED': 'true'}
        command = [self.binary, 'sts' if operation == 'get-caller-identity' else 'lambda-microvms', operation,
                   '--profile', self.profile, '--region', self.region, '--cli-input-json', 'file://' + str(request_path),
                   '--output', 'json', '--no-cli-pager', '--no-paginate', '--cli-connect-timeout', '5',
                   '--cli-read-timeout', str(max(1, int(timeout)))]
        started = time.monotonic()
        event = {'sequence': sequence, 'operation': operation, 'outcome': 'unavailable'}
        try:
            with output_path.open('wb') as output, error_path.open('wb') as errors:
                output_path.chmod(0o600)
                error_path.chmod(0o600)
                process = subprocess.Popen(command, env=env, stdout=output, stderr=errors,
                                           stdin=subprocess.DEVNULL, start_new_session=True)
                try:
                    process.wait(timeout=timeout)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
                    raise Unavailable('verification cloud operation timed out') from None
            if process.returncode:
                event['returnCode'] = process.returncode
                raise Unavailable('verification cloud operation unavailable')
            if output_path.stat().st_size > 1024 * 1024:
                raise Unavailable('verification cloud response too large')
            result = json.loads(output_path.read_bytes())
            if not isinstance(result, dict):
                raise Unavailable('verification cloud response malformed')
            event['outcome'] = 'returned'
            return result
        finally:
            event['durationMs'] = round((time.monotonic() - started) * 1000)
            with self.lock:
                self.events.append(event)


def probe_source(core_ip):
    # These are direct socket probes in smoke mode, not patched unittest sockets.
    return '''import json, os, socket, struct, sys
sys.path.insert(0, os.getcwd())
from api.main import create_app
os.environ['TASKTRACKR_DB'] = ':memory:'
app = create_app()
client = app.test_client()
health = client.get('/api/health')
created = client.post('/api/lists', json={'name':'Isolated cloud smoke'})
read = client.get('/api/lists')
positive = health.status_code == 200 and created.status_code == 201 and read.status_code == 200 and any(x['id'] == created.json['id'] for x in read.json)
checks = {'current_source_flask_sqlite': positive}
probe_details = {}
for name, host, port in [('internet', '1.1.1.1', 443), ('core', CORE_IP, 443), ('metadata', '169.254.169.254', 80)]:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(2)
    try:
        sock.connect((host,port))
        checks[name + '_connection_denied'] = False
        probe_details[name] = 'connected'
    except OSError as error:
        checks[name + '_connection_denied'] = True
        probe_details[name] = type(error).__name__
    finally:
        sock.close()
for name, host in [('linklocal_dns','169.254.169.253'),('vpc_dns','10.49.0.2')]:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(2)
    packet = struct.pack('!HHHHHH', 0x4c53, 0x0100, 1, 0, 0, 0) + b'\\x07example\\x03com\\x00' + struct.pack('!HH',1,1)
    try:
        sock.sendto(packet,(host,53))
        answer, _ = sock.recvfrom(4096)
        ident, flags, questions, answers, authorities, additional = struct.unpack('!HHHHHH', answer[:12])
        checks[name + '_resolution_denied'] = ident == 0x4c53 and bool(flags & 0x8000) and answers == 0
        probe_details[name] = {'rcode': flags & 15, 'answerCount': answers}
    except OSError as error:
        checks[name + '_resolution_denied'] = True
        probe_details[name] = type(error).__name__
    finally:
        sock.close()
secret_names = {'AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY','AWS_SESSION_TOKEN','AWS_CONTAINER_CREDENTIALS_FULL_URI','AWS_CONTAINER_CREDENTIALS_RELATIVE_URI','AWS_WEB_IDENTITY_TOKEN_FILE','LEARN_SDLC_CONTROL_TOKEN','MICROVM_CONTROL_TOKEN'}
checks['guest_credentials_absent'] = not bool(secret_names & set(os.environ))
print('MICROVM_BOUNDARY_RESULT=' + json.dumps({'checks':checks,'probes':probe_details},sort_keys=True))
assert all(checks.values()), 'one or more runtime boundary checks failed'
print('CURRENT_SOURCE_AND_BOUNDARIES_PASS')
'''.replace('CORE_IP', repr(core_ip))


def jobs(core_ip, case_set='baseline'):
    canonical = ROOT / 'content/tasktrackr/canonical'
    files = {str(path.relative_to(canonical)): path.read_text()
             for path in (canonical / 'api').rglob('*')
             if path.is_file() and path.suffix in ('.py', '.sql')}
    source_hash = hashlib.sha256(encode(files)).hexdigest()
    files['cloud_probe.py'] = probe_source(core_ip)
    cases = [
        ('current-source-and-network-boundaries', {'mode':'smoke', 'language':'python', 'files':files,
         'timeoutSeconds':25, 'memoryMb':256, 'smokeCommands':[['python3','cloud_probe.py']],
         'expectInOutput':'CURRENT_SOURCE_AND_BOUNDARIES_PASS'}),
        ('intentional-test-failure', {'mode':'tests', 'language':'python',
         'files':{'test_intentional.py':'import unittest\nclass IntentionalFailure(unittest.TestCase):\n    def test_rejection_is_not_success(self):\n        self.assertEqual(1, 2, "intentional verification failure")\n'},
         'testPaths':['test_intentional.py'], 'timeoutSeconds':15, 'memoryMb':256})]
    if case_set == 'diagnostic':
        cases[0] = ('metadata-credential-diagnostic', {'mode':'smoke', 'language':'python',
            'files':{'metadata_probe.py':Path(__file__).with_name('metadata_probe.py').read_text()},
            'timeoutSeconds':25, 'memoryMb':256, 'smokeCommands':[['python3','metadata_probe.py']],
            'expectInOutput':'METADATA_CREDENTIAL_FIELDS_ABSENT'})
    return source_hash, cases


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', action='store_true')
    parser.add_argument('--case-set', choices=['baseline','diagnostic'], default='baseline')
    parser.add_argument('--report', default=str(Path(__file__).with_name('real-verification.json')))
    parser.add_argument('--profile', required=True, help='AWS CLI profile of the approved operator identity')
    parser.add_argument('--region', default=PREVIEW_REGION, help='AWS region (the controller accepts only %s)' % PREVIEW_REGION)
    parser.add_argument('--aws-bin', default=AWS_BIN, help='AWS CLI binary (default: aws on PATH)')
    parser.add_argument('--outputs', required=True, help='Terraform outputs JSON of the deployment (terraform output -json)')
    parser.add_argument('--evidence-dir', required=True,
                        help="private folder, outside any repository, for each run's requests and answers")
    parser.add_argument('--image-name', default=IMAGE_NAME, help='MicroVM image name the outputs must name')
    args = parser.parse_args()
    region = args.region
    if not args.run:
        raise SystemExit('Explicit --run required; creates at most two short-lived authorized MicroVMs.')
    report_path = Path(args.report).resolve()
    if report_path.exists():
        raise SystemExit('Refusing to overwrite earlier verification evidence.')
    os.umask(0o077)
    folder = Path(args.evidence_dir).resolve() / ('microvm-controller-real-' + str(uuid.uuid4()))
    folder.mkdir(mode=0o700, parents=True)
    raw = json.loads(Path(args.outputs).read_text())
    values = {k:v['value'] for k,v in raw.items()}
    image = values['microvm_image_arn']
    if not image.endswith(':microvm-image:' + args.image_name):
        raise SystemExit('Unexpected image: no launches performed.')
    cloud = OperatorVerificationCli(folder, args.aws_bin, args.profile, region)
    report = {'startedAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()), 'region':region,
              'imageName':args.image_name,'imageVersion':'1.0','maximumVmLifeSeconds':180,
              'maxDistinctInstances':2,'noExecutionRole':True,'providerCalls':0,'caseSet':args.case_set,
              'privateEvidence':str(folder), 'cases':[], 'cleanup':[], 'status':'running'}
    bridge = registry = None
    try:
        identity = cloud.call('get-caller-identity', {})
        if identity.get('Account') != image.split(':')[4]:
            raise Unavailable('operator identity does not match the approved image account')
        report['operatorAccountMatchesImage'] = True
        report['operatorIdentityKind'] = 'explicitly-authorized-root-test-profile' if identity.get('Arn','').endswith(':root') else 'approved-profile'
        report['productionCredentials'] = 'unchanged: EC2 host role only'
        config = Config(region, image, '1.0',
                        'arn:aws:lambda:' + region + ':aws:network-connector:aws-network-connector:ALL_INGRESS',
                        values['learner_egress_connector_arn'], job_life=180)
        registry = Registry(folder / 'registry.sqlite')
        class ObservedGuest(GuestHttp):
            def request(self, row, route, body=None, timeout=30):
                result = super().request(row,route,body,timeout)
                if route == '/execute':
                    private_write(folder / (row['id']+'-guest-result-before-validation.json'),result)
                return result
        bridge = Bridge(config, registry, cloud, ObservedGuest(cloud, region))
        source_hash, cases = jobs(values['public_ip'], args.case_set)
        report['canonicalPythonSourceHash'] = source_hash
        for label, job in cases:
            started = time.monotonic()
            private_write(folder / (label + '-job.json'), job)
            item = {'name':label, 'sourceHash':hashlib.sha256(encode(job)).hexdigest()}
            report['cases'].append(item)
            try:
                result = bridge.execute(job)
                private_write(folder / (label + '-result.json'), result)
                item.update(ok=result['ok'], exitKind=result['exitKind'], durationMs=result['durationMs'])
                if 'tests' in result:
                    item['tests'] = {k:result['tests'][k] for k in ('total','passed','failed','errored')}
                if label == 'current-source-and-network-boundaries':
                    marker = 'MICROVM_BOUNDARY_RESULT='
                    line = next((line[len(marker):] for line in result['stdout'].splitlines() if line.startswith(marker)), None)
                    item['boundaries'] = json.loads(line) if line else None
                    item['passed'] = result['ok'] is True and bool(item['boundaries']) and all(item['boundaries']['checks'].values())
                elif label == 'metadata-credential-diagnostic':
                    marker = 'MICROVM_METADATA_RESULT='
                    line = next((line[len(marker):] for line in result['stdout'].splitlines() if line.startswith(marker)), None)
                    item['metadata'] = json.loads(line) if line else None
                    item['passed'] = result['ok'] is True and bool(item['metadata']) and all(item['metadata']['checks'].values())
                else:
                    item['passed'] = result['ok'] is False and result['exitKind'] == 'ok' and item.get('tests') == {'total':1,'passed':0,'failed':1,'errored':0}
            except Exception as error:
                item.update(passed=False, failure=type(error).__name__, message=str(error))
                raise
            finally:
                item['wallMs'] = round((time.monotonic()-started)*1000)
                report_path.write_text(json.dumps(report,indent=2)+'\n')
            if label == 'metadata-credential-diagnostic' and not item['passed']:
                raise Unavailable('metadata safety diagnostic did not pass; further launch withheld')
            # Observe completed teardown before starting the second bounded VM.
            deadline = time.monotonic() + 60
            while registry.active() and time.monotonic() < deadline:
                bridge.sweep()
                time.sleep(2)
            if registry.active():
                raise Unavailable('first VM teardown not yet confirmed; second launch withheld')
        report['status'] = 'passed' if all(c['passed'] for c in report['cases']) else 'failed'
    except Exception as error:
        report.update(status='failed', failure=type(error).__name__, message=str(error))
    finally:
        if bridge:
            bridge.shutdown()
            deadline = time.monotonic()+100
            while registry.active() and time.monotonic()<deadline:
                bridge.sweep()
                time.sleep(2)
            rows = [dict(r) for r in registry.db.execute('SELECT id,vm_id,state,source_hash,launch_attempts FROM operations')]
            private_write(folder / 'final-operations.json', rows)
            report['cleanup'] = [{'operationHash':hashlib.sha256(r['id'].encode()).hexdigest(),
                                  'vmIdKnown':bool(r['vm_id']),'state':r['state'],
                                  'launchAttempts':r['launch_attempts']} for r in rows]
            report['allKnownInstancesConfirmedTerminated'] = bool(rows) and all(r['vm_id'] and r['state']=='terminated' for r in rows)
            if not report['allKnownInstancesConfirmedTerminated']:
                report['status']='failed'
            registry.close()
        report['cloudOperations']=dict(Counter(e['operation'] for e in cloud.events))
        report['cloudOperationEvents']=sorted(cloud.events,key=lambda e:e['sequence'])
        report['finishedAt']=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())
        report['limits']=['Two fresh finite VMs only; no deployed preview lifecycle or concurrent load proof.',
                          'Direct TCP/UDP probes are bounded destination samples, not a comprehensive penetration test.',
                          'Flask/SQLite writes occurred only inside disposable learner MicroVMs; no course records modified.']
        report_path.write_text(json.dumps(report,indent=2)+'\n')
        report_path.chmod(0o644)
        print(json.dumps({'status':report['status'],'cases':len(report['cases']),
                          'cleanupConfirmed':report.get('allKnownInstancesConfirmedTerminated',False),
                          'report':str(report_path)}))
    return 0 if report['status']=='passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
