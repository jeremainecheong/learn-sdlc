#!/usr/bin/env python3
"""Run mocked Cognito plans in a temporary config, never the live state dir."""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

from package import build


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--terraform", default="terraform", help="Terraform >=1.9 executable with the locked AWS provider already installed")
    args = parser.parse_args()
    binary = shutil.which(args.terraform)
    if binary is None:
        raise SystemExit("Terraform executable not found.")
    folder = Path(__file__).resolve().parent
    source = folder.parent / "terraform"
    providers = source / ".terraform/providers"
    if not providers.is_dir():
        raise SystemExit("Install the locked providers with terraform init -backend=false first.")
    with tempfile.TemporaryDirectory(prefix="learnsdlc-cognito-tf-") as temporary:
        config = Path(temporary)
        for file in source.glob("*.tf"):
            shutil.copyfile(file, config / file.name)
        shutil.copyfile(source / ".terraform.lock.hcl", config / ".terraform.lock.hcl")
        shutil.copytree(source / "templates", config / "templates")
        shutil.copytree(folder / "tests", config / "tests")
        (config / ".terraform").mkdir()
        (config / ".terraform/providers").symlink_to(providers)
        # Do not copy tfstate, tfvars, plans, credentials or remote backend
        # initialization. The mock_provider supplies every AWS response.
        artifact = build(config / "migration.zip")
        environment = {k: v for k, v in os.environ.items()
                       if not k.startswith(("AWS_", "TF_VAR_", "TF_CLI_ARGS")) and k != "TF_DATA_DIR"}
        environment.update({"AWS_EC2_METADATA_DISABLED": "true", "AWS_IGNORE_CONFIGURED_ENDPOINT_URLS": "true"})
        result = subprocess.run([binary, f"-chdir={config}", "test", "-no-color",
                                 f"-var=cognito_migration_zip_path={artifact}"], env=environment, check=False)
        return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
