#!/usr/bin/env python3
"""Provision only the Google IdP without putting OAuth secrets in Terraform.

Validation is offline unless --apply is supplied. AWS CLI request/response
content is captured, never printed; only nonsecret completion metadata leaves
the helper. App-client provider enablement remains reviewed Terraform config.
"""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import tempfile

# The one AWS region the preview's user pool lives in (the controller's cloud.py names the same region).
PREVIEW_REGION = "ap-southeast-1"


class ProvisioningError(Exception):
    pass


def _object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ProvisioningError("Duplicate configuration keys are not allowed.")
        value[key] = item
    return value


def read_config(filename):
    # Validate the opened descriptor, so a symlink/swap can't evade the mode
    # check. Never read a group/world-readable or differently owned secret.
    descriptor = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, "rb") as stream:
        info = os.fstat(stream.fileno())
        if (not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600
                or info.st_uid != os.geteuid() or info.st_size > 8192):
            raise ProvisioningError("Configuration must be an owned regular file with mode 0600, at most 8 KiB.")
        raw = stream.read(8193)
    if len(raw) > 8192:
        raise ProvisioningError("Configuration is too large.")
    value = json.loads(raw.decode("utf-8"), object_pairs_hook=_object)
    fields = {"awsProfile", "awsRegion", "expectedAccountId", "userPoolId", "clientId", "clientSecret"}
    if not isinstance(value, dict) or set(value) != fields or not all(isinstance(v, str) for v in value.values()):
        raise ProvisioningError("Configuration fields do not match the documented Google provisioning format.")
    if (not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}", value["awsProfile"])
            or value["awsRegion"] != PREVIEW_REGION
            or not re.fullmatch(r"[0-9]{12}", value["expectedAccountId"])
            or not re.fullmatch(re.escape(PREVIEW_REGION) + r"_[A-Za-z0-9]+", value["userPoolId"])
            or not re.fullmatch(r"[A-Za-z0-9_-]{1,220}\.apps\.googleusercontent\.com", value["clientId"])
            or not 8 <= len(value["clientSecret"]) <= 512
            or any(ord(c) < 33 or ord(c) > 126 for c in value["clientSecret"])):
        raise ProvisioningError("Invalid Google provisioning metadata or credentials.")
    return value


def _aws(binary, config, arguments, *, payload=None, decode=True):
    command = [binary, "--profile", config["awsProfile"], "--region", config["awsRegion"],
               "--no-cli-pager", "--output", "json", *arguments]
    environment = {**os.environ, "AWS_PAGER": "", "AWS_CLI_AUTO_PROMPT": "off",
                   "AWS_IGNORE_CONFIGURED_ENDPOINT_URLS": "true", "AWS_EC2_METADATA_DISABLED": "true"}
    # A private file keeps the Google secret out of argv, process listings,
    # shell history and AWS CLI debug output. Never enable --debug here.
    with tempfile.TemporaryDirectory(prefix="learnsdlc-google-") as folder:
        if payload is not None:
            path = Path(folder) / "request.json"
            descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "w") as stream:
                json.dump(payload, stream, ensure_ascii=False, separators=(",", ":"))
            command += ["--cli-input-json", "file://" + str(path)]
        result = subprocess.run(command, capture_output=True, env=environment, timeout=30, check=False)
    if result.returncode != 0:
        # AWS errors can include provider details. Do not expose stdout/stderr.
        raise ProvisioningError("AWS rejected Google provisioning; no credentials were printed. Check operator permissions and configuration.")
    if not decode:
        return None
    return json.loads(result.stdout.decode("utf-8"))


def provision(config, binary):
    identity = _aws(binary, config, ["sts", "get-caller-identity"])
    if not isinstance(identity, dict) or identity.get("Account") != config["expectedAccountId"]:
        raise ProvisioningError("AWS account identity differs from the expected preview account; no changes made.")
    providers = _aws(binary, config, ["cognito-idp", "list-identity-providers", "--user-pool-id", config["userPoolId"]])
    if not isinstance(providers, dict) or not isinstance(providers.get("Providers"), list):
        raise ProvisioningError("Could not verify existing provider metadata; no changes made.")
    matching = [p for p in providers["Providers"] if isinstance(p, dict) and p.get("ProviderName") == "Google"]
    if len(matching) > 1 or (matching and matching[0].get("ProviderType") != "Google"):
        raise ProvisioningError("An unexpected provider occupies the Google name; no changes made.")
    payload = {
        "UserPoolId": config["userPoolId"], "ProviderName": "Google",
        "ProviderDetails": {"client_id": config["clientId"], "client_secret": config["clientSecret"],
                            "authorize_scopes": "openid email profile"},
        "AttributeMapping": {"email": "email", "email_verified": "email_verified", "name": "name"},
    }
    action = "update-identity-provider" if matching else "create-identity-provider"
    if not matching:
        payload["ProviderType"] = "Google"
    _aws(binary, config, ["cognito-idp", action], payload=payload, decode=False)
    return "updated" if matching else "created"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, help="Owned mode-0600 local JSON file; never a Terraform variable file")
    parser.add_argument("--aws-cli", default="aws", help="Optional path to the reviewed AWS CLI executable")
    parser.add_argument("--apply", action="store_true", help="Verify AWS account and create/update the Google IdP")
    args = parser.parse_args(argv)
    try:
        config = read_config(args.config)
        if not args.apply:
            print("Google configuration is valid. No AWS requests made; use --apply to provision the provider.")
            return 0
        binary = shutil.which(args.aws_cli)
        if not binary:
            raise ProvisioningError("The selected AWS CLI is unavailable.")
        action = provision(config, binary)
        print(f"Google provider {action}. Enable Google in cognito_identity_providers and COGNITO_PROVIDERS after verifying its callback.")
        return 0
    except ProvisioningError as error:
        print(str(error))
    except Exception:
        # Parser, process and filesystem errors can contain raw secret input.
        print("Google provisioning failed. Check the private configuration and AWS CLI; no credentials were printed.")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
