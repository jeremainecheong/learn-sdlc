"""Exercise the actual ARM guest image locally. This does not test AWS itself."""

import argparse
import base64
import json
import subprocess
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
DRIVER = r'''
import base64, hashlib, http.client, json, os, secrets, sys, time, uuid
payload = json.loads(__PAYLOAD__)
def request(method, path, body=None, auth=True):
    raw = body if isinstance(body, bytes) else json.dumps(body or {},sort_keys=True,separators=(',',':'),ensure_ascii=False,allow_nan=False).encode()
    headers = {'Content-Type':'application/json'}
    if auth: headers.update({'Authorization':'Bearer '+token,'X-LearnSDLC-Instance':instance})
    connection = http.client.HTTPConnection('127.0.0.1',8081,timeout=90)
    connection.request(method,path,raw,headers)
    response = connection.getresponse()
    result = (response.status,json.loads(response.read()))
    connection.close()
    return result
deadline = time.monotonic()+35
while True:
    try:
        code, _ = request('POST','/aws/lambda-microvms/runtime/v1/ready',auth=False)
        if code == 200: break
    except (OSError, ValueError): pass
    if time.monotonic() > deadline: raise RuntimeError('guest readiness timeout')
    time.sleep(.2)
instance,token = str(uuid.uuid4()),secrets.token_hex(32)
raw=json.dumps(payload['job'],sort_keys=True,separators=(',',':'),ensure_ascii=False,allow_nan=False).encode()
binding={'protocol':'learnsdlc-microvm-v1','instanceId':instance,'controlToken':token,'purpose':payload['purpose'],'sourceHash':hashlib.sha256(raw).hexdigest()}
code,_=request('POST','/aws/lambda-microvms/runtime/v1/run',{'microvmId':'mvm-local-smoke','runHookPayload':json.dumps(binding)},auth=False)
assert code==200,code
assert request('GET','/health',auth=False)[0]==403
health=request('GET','/health')[1]
assert health['uid']==65534 and health['instanceId']==instance,health
path='/execute' if payload['purpose']=='job' else '/app/start'
assert request('POST',path,b'{}')[0]==409
code,envelope=request('POST',path,raw)
assert code==200,(code,envelope)
assert envelope['instanceId']==instance and envelope['sourceHash']==binding['sourceHash'],envelope
assert request('POST',path,raw)==(code,envelope),'duplicate source executed a second time'
result=envelope['result']
if payload['purpose']=='job':
    assert result['ok'] is payload.get('expectedOk',True),result
    if payload.get('tests') is not None: assert result['tests']['total']==payload['tests'],result
    print(json.dumps({'case':payload['name'],'ok':True,'exitKind':result['exitKind'],'tests':result.get('tests'),'result':result}))
else:
    session_id=result['id']
    deadline=time.monotonic()+35
    while result['status']=='starting' and time.monotonic()<deadline:
        time.sleep(.2)
        code,envelope=request('POST','/app/status',{'id':session_id})
        assert code==200,(code,envelope)
        result=envelope['result']
    assert result['status']=='ready',result
    assert result['bundleOk'] is True,result
    code,answer=request('POST','/app/proxy',{'id':session_id,'method':'GET','path':'/api/health'})
    assert code==200 and answer['result']['status']==200,(code,answer)
    api=answer['result']
    code,asset=request('POST','/app/asset',{'id':session_id,'path':'/app.js'})
    assert code==200 and asset['result']['status']==200,(code,asset)
    assert len(base64.b64decode(asset['result']['body']))>1000,asset
    assert request('POST','/app/status',{'id':'wrong-session'})[0]==404
    assert request('POST','/app/stop',{'id':session_id})[0]==200
    print(json.dumps({'case':payload['name'],'ok':True,'bundleOk':True,'healthStatus':api['status'],'bundleBytes':len(base64.b64decode(asset['result']['body']))}))
'''


def project_preview():
    pack = ROOT / "content/tasktrackr"
    project = json.loads((pack / "project.json").read_text())
    files = {}
    for directory in (pack / "canonical", pack / "phases/03-implementation/files"):
        if not directory.is_dir():
            raise RuntimeError(f"Expected TaskTrackr source directory {directory}")
        for path in directory.rglob("*"):
            if path.is_file() and "__pycache__" not in path.parts:
                files[path.relative_to(directory).as_posix()] = path.read_text()
    return {"mode": "preview", "files": files, "build": project["build"], **project["preview"]}


def run_case(image, case):
    name = "learnsdlc-guest-smoke-" + uuid.uuid4().hex[:10]
    subprocess.run([
        "docker", "run", "--detach", "--name", name, "--network", "none", "--memory", "768m",
        "--cpus", "1", "--pids-limit", "128", "--cap-drop", "ALL", "--cap-add", "CHOWN",
        "--cap-add", "SETUID", "--cap-add", "SETGID", "--cap-add", "DAC_OVERRIDE",
        "--security-opt", "no-new-privileges:true", "--env", "MICROVM_TEST_SENTINEL=must-not-inherit", image,
    ], check=True, capture_output=True, text=True)
    try:
        # The request token is generated inside the driver and never appears in
        # command arguments, the environment, output or the local test report.
        result = subprocess.run(
            ["docker", "exec", "--interactive", name, "python3", "-"],
            input=DRIVER.replace("__PAYLOAD__", repr(json.dumps(case))), capture_output=True, text=True, timeout=160,
        )
        if result.returncode:
            logs = subprocess.run(["docker", "logs", name], capture_output=True, text=True)
            raise RuntimeError(result.stderr + "\nGuest startup diagnostics:\n" + logs.stderr)
        # OS-level refusals bypass Python's teaching sandbox policy and test the
        # privileged control process and socket directory directly as learner uid.
        probe = subprocess.run([
            "docker", "exec", "--user", "65534:65534", name, "python3", "-c",
            "import os,socket; "
            "assert not os.access('/run/learnsdlc-guest',os.X_OK); "
            "assert not os.access('/proc/1/environ',os.R_OK); "
            "assert not os.access('/opt/learnsdlc-guest/gateway.py',os.W_OK); "
            "print('control filesystem and process memory protected')",
        ], capture_output=True, text=True)
        if probe.returncode:
            raise RuntimeError(probe.stderr)
        return json.loads(result.stdout.strip())
    finally:
        subprocess.run(["docker", "rm", "--force", name], capture_output=True, check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", default="learnsdlc-microvm-guest:preview-local")
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    python_tests = '''import os, unittest
import flask
class Runtime(unittest.TestCase):
    def test_uid(self): self.assertEqual(os.getuid(),65534)
    def test_scrubbed_environment(self): self.assertNotIn('MICROVM_TEST_SENTINEL',os.environ)
    def test_flask(self): self.assertEqual(flask.Flask(__name__).test_client().get('/').status_code,404)
'''
    cases = [
        {"name": "python-and-privilege-boundary", "purpose": "job", "tests": 3,
         "job": {"mode": "tests", "language": "python", "files": {"tests/test_runtime.py": python_tests},
                 "testPaths": ["tests/test_runtime.py"], "timeoutSeconds": 15}},
        {"name": "real-failed-test-remains-failed", "purpose": "job", "tests": 1, "expectedOk": False,
         "job": {"mode": "tests", "language": "python", "files": {"test_failure.py": "import unittest\nclass Failure(unittest.TestCase):\n def test_failure(self): self.assertEqual(1,2)\n"},
                 "testPaths": ["test_failure.py"], "timeoutSeconds": 15}},
        {"name": "typescript-react-esbuild", "purpose": "job", "tests": 1,
         "job": {"mode": "tests", "language": "typescript", "transform": {"tool": "esbuild"},
                 "files": {"runtime.test.tsx": "import React from 'react';\nimport {render,screen} from '@testing-library/react';\ntest('React renders',()=>{render(<button>ready</button>);assert.equal(screen.getByRole('button').textContent,'ready');});\n"},
                 "testPaths": ["runtime.test.tsx"], "timeoutSeconds": 20, "memoryMb": 512}},
        {"name": "actual-tasktrackr-preview", "purpose": "preview", "job": project_preview()},
    ]
    started = time.monotonic()
    results = []
    for case in cases:
        result = run_case(args.image, case)
        results.append(result)
        print(json.dumps({key: value for key, value in result.items() if key != "result"}), flush=True)
    report = {"ok": True, "cases": len(results), "seconds": round(time.monotonic() - started, 2), "results": results,
              "coverage": "Local ARM Docker image, real runner and TaskTrackr. AWS MicroVM lifecycle/networking is separate."}
    if args.report:
        args.report.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({key: value for key, value in report.items() if key != "results"}))


if __name__ == "__main__":
    main()
