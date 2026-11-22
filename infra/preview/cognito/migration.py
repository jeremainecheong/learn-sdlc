"""Trusted Cognito migration trigger. Never log the event or transport errors.

Only the configured pool can invoke this function (Lambda resource policy).
The application checks that exact pool again, the HMAC, freshness and nonce
before reading legacy credentials. This function has no learner runtime role.
"""
import contextlib
import hashlib
import hmac
import http.client
import json
import logging
import os
import re
import secrets
import signal
import ssl
import time
from urllib.parse import urlsplit
from uuid import UUID


MAX_BYTES = 4096
MIGRATE_AUTH = "UserMigration_Authentication"
MIGRATE_FORGOT = "UserMigration_ForgotPassword"
SIGNUP_NATIVE = "PreSignUp_SignUp"
SIGNUP_EXTERNAL = "PreSignUp_ExternalProvider"
SIGNUP_ADMIN = "PreSignUp_AdminCreateUser"
FAILURE = "Account migration could not be verified. Retry or contact support."
_key_cache = None
_secret_client = None
_logger = logging.getLogger(__name__)


class MigrationRejected(Exception):
    """A deliberately generic error, safe for Cognito and Lambda runtime logs."""


class _DeadlineExceeded(MigrationRejected):
    pass


class _SecretSetupUnavailable(MigrationRejected):
    pass


def _reject():
    raise MigrationRejected(FAILURE)


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            _reject()
        result[key] = value
    return result


def _json(raw):
    if len(raw) > MAX_BYTES:
        _reject()
    return json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_object,
                      parse_constant=lambda _: _reject())


def _text(value, minimum, maximum):
    return (isinstance(value, str) and minimum <= len(value) <= maximum
            and not any(ord(c) < 32 or ord(c) == 127 for c in value))


def _email(value):
    if not _text(value, 3, 320) or value != value.strip() or not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", value):
        _reject()
    return value.lower()


def _settings():
    region = os.environ["EXPECTED_REGION"]
    account = os.environ["EXPECTED_ACCOUNT_ID"]
    endpoint = urlsplit(os.environ["MIGRATION_ENDPOINT"])
    arn = os.environ["MIGRATION_SECRET_ARN"]
    if (not re.fullmatch(r"[a-z]{2}(?:-[a-z]+)+-\d", region)
            or not re.fullmatch(r"[0-9]{12}", account)
            or endpoint.scheme != "https" or endpoint.username or endpoint.password
            or endpoint.port is not None or endpoint.query or endpoint.fragment
            or endpoint.path != "/api/v1/auth/cognito/migrate"
            or not endpoint.hostname or not re.fullmatch(r"[a-z0-9][a-z0-9.-]*[a-z0-9]", endpoint.hostname)
            or not re.fullmatch(rf"arn:aws:secretsmanager:{re.escape(region)}:{account}:secret:[A-Za-z0-9/_+=.@-]+", arn)):
        _reject()
    return region, endpoint, arn


@contextlib.contextmanager
def _deadline(context):
    # A per-socket timeout alone doesn't bound DNS resolution, the SDK, or a
    # slow response across multiple reads. Lambda's Python runtime invokes on
    # the main thread, so one alarm bounds the entire request, including DNS.
    remaining = context.get_remaining_time_in_millis() / 1000
    budget = min(3.5, remaining - 0.5)
    if budget < 0.25:
        _reject()
    previous_handler = signal.getsignal(signal.SIGALRM)
    previous_timer = signal.getitimer(signal.ITIMER_REAL)
    if previous_timer[0] or previous_timer[1]:
        _reject()
    def expired(*_):
        raise _DeadlineExceeded(FAILURE)

    signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, budget)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous_handler)


def _initialize_secret_client():
    # SDK imports and service-model construction are CPU-heavy on a cold
    # Python Lambda. Prepare them once during Init, before the handler's
    # bounded request work. No secret is fetched or cached during Init.
    # Cognito's end-to-end five-second limit still requires adequate memory;
    # moving initialization is not an extension of that service limit.
    try:
        region, _, _ = _settings()
        import boto3
        from botocore.config import Config
        return region, boto3.client("secretsmanager", region_name=region, config=Config(
            connect_timeout=0.5, read_timeout=0.75,
            retries={"total_max_attempts": 1, "mode": "standard"}))
    except Exception:
        # Never log SDK/config exceptions, which can include credentials or
        # URLs. The handler reports only the allowlisted setup-failure stage.
        return None


def _migration_key(region, arn):
    global _key_cache
    if _key_cache and _key_cache[0] == arn and time.monotonic() < _key_cache[1]:
        return _key_cache[2]
    if _secret_client is None or _secret_client[0] != region:
        raise _SecretSetupUnavailable(FAILURE)
    client = _secret_client[1]
    value = client.get_secret_value(SecretId=arn)["SecretString"]
    if not isinstance(value, str):
        _reject()
    document = _json(value.encode("utf-8"))
    if (not isinstance(document, dict) or set(document) != {"hmacKey"}
            or not isinstance(document["hmacKey"], str)
            or not re.fullmatch(r"[0-9a-f]{64}", document["hmacKey"])):
        _reject()
    key = bytes.fromhex(document["hmacKey"])
    _key_cache = (arn, time.monotonic() + 60, key)
    return key


def _validate_event(event, region):
    if not isinstance(event, dict) or event.get("version") != "1" or event.get("region") != region:
        _reject()
    trigger = event.get("triggerSource")
    pool = event.get("userPoolId")
    request = event.get("request")
    if (trigger not in (MIGRATE_AUTH, MIGRATE_FORGOT, SIGNUP_NATIVE, SIGNUP_EXTERNAL, SIGNUP_ADMIN)
            or not isinstance(pool, str)
            or not re.fullmatch(rf"{re.escape(region)}_[A-Za-z0-9]+", pool)
            or not isinstance(request, dict)):
        _reject()
    return trigger, pool, request


def _payload(event, region):
    trigger, pool, request = _validate_event(event, region)
    if trigger not in (MIGRATE_AUTH, MIGRATE_FORGOT):
        _reject()
    email = _email(event.get("userName"))
    password = request.get("password")
    if trigger == MIGRATE_AUTH:
        if not isinstance(password, str) or not 1 <= len(password) <= 1024:
            _reject()
    elif password is not None:
        _reject()
    document = {"email": email, "password": password, "poolId": pool, "trigger": trigger}
    raw = json.dumps(document, sort_keys=True, separators=(",", ":"),
                     ensure_ascii=False, allow_nan=False).encode("utf-8")
    if len(raw) > MAX_BYTES:
        _reject()
    return document, raw


def _signup(event, region, key):
    trigger, pool, request = _validate_event(event, region)
    if trigger != SIGNUP_NATIVE:
        _reject()
    attributes = request.get("userAttributes")
    metadata = request.get("clientMetadata")
    if not isinstance(attributes, dict) or not isinstance(metadata, dict):
        _reject()
    email = _email(attributes.get("email"))
    if attributes["email"] != email:
        _reject()
    # With email username attributes, Cognito can assign an internal username
    # instead of the supplied email. Bind proof to the canonical email; don't
    # infer identity from the shape of this Cognito-provided display field.
    username = event.get("userName")
    if not _text(username, 1, 128):
        _reject()
    timestamp = metadata.get("signupTimestamp")
    nonce = metadata.get("signupNonce")
    signature = metadata.get("signupSignature")
    if (not isinstance(timestamp, str) or not re.fullmatch(r"[0-9]{10,12}", timestamp)
            or abs(int(time.time()) - int(timestamp)) > 60
            or not isinstance(nonce, str) or not re.fullmatch(r"[0-9a-f]{32}", nonce)
            or not isinstance(signature, str) or not re.fullmatch(r"[0-9a-f]{64}", signature)):
        _reject()
    signed = f"signup.{timestamp}.{nonce}.{email}.{pool}".encode("utf-8")
    expected = hmac.new(key, signed, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, signature):
        _reject()
    return {**event, "response": {"autoConfirmUser": False,
            "autoVerifyEmail": False, "autoVerifyPhone": False}}


def _post(endpoint, body, key):
    timestamp = str(int(time.time()))
    nonce = secrets.token_hex(16)
    signed = timestamp.encode("ascii") + b"." + nonce.encode("ascii") + b"." + body
    signature = hmac.new(key, signed, hashlib.sha256).hexdigest()
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "X-Cognito-Migration-Timestamp": timestamp,
        "X-Cognito-Migration-Nonce": nonce,
        "X-Cognito-Migration-Signature": signature,
    }
    connection = http.client.HTTPSConnection(endpoint.hostname, timeout=1.25,
                                             context=ssl.create_default_context())
    try:
        # http.client never follows redirects. Neither the origin nor path can
        # be supplied by a user, a Cognito event, or a provider response.
        connection.request("POST", endpoint.path, body=body, headers=headers)
        response = connection.getresponse()
        if response.status != 200 or response.getheader("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json":
            _reject()
        if response.getheader("Content-Encoding", "identity").lower() != "identity":
            _reject()
        length = response.getheader("Content-Length")
        if length is not None and (not length.isdigit() or int(length) > MAX_BYTES):
            _reject()
        return _json(response.read(MAX_BYTES + 1))
    finally:
        connection.close()


def _response(event, payload, user):
    if not isinstance(user, dict) or set(user) != {"id", "email", "emailVerified", "displayName"}:
        _reject()
    if (not isinstance(user["id"], str) or str(UUID(user["id"])) != user["id"]
            or user["email"] != payload["email"]
            or type(user["emailVerified"]) is not bool
            or not _text(user["displayName"], 1, 120)
            or user["displayName"] != user["displayName"].strip()):
        _reject()
    if payload["trigger"] == MIGRATE_FORGOT and not user["emailVerified"]:
        _reject()
    # Build only an allowlisted response; no role or provider claims are
    # accepted from Cognito clientMetadata or copied from upstream payloads.
    return {**event, "response": {
        "userAttributes": {
            "email": user["email"],
            "email_verified": str(user["emailVerified"]).lower(),
            "name": user["displayName"],
            "custom:learnsdlc_id": user["id"],
        },
        "finalUserStatus": "CONFIRMED" if payload["trigger"] == MIGRATE_AUTH else "RESET_REQUIRED",
        "messageAction": "SUPPRESS",
        "desiredDeliveryMediums": ["EMAIL"],
        "forceAliasCreation": False,
    }}


def handler(event, context):
    stage = "deadline"
    try:
        with _deadline(context):
            stage = "settings"
            region, endpoint, arn = _settings()
            stage = "event"
            trigger, _, _ = _validate_event(event, region)
            # Cognito creates these events only after authenticating an IdP
            # or an IAM-authorized administrator. Public SignUp cannot select
            # a trigger source. Application account linkage stays separate.
            if trigger in (SIGNUP_EXTERNAL, SIGNUP_ADMIN):
                return event
            if trigger == SIGNUP_NATIVE:
                stage = "secret_lookup"
                key = _migration_key(region, arn)
                stage = "signup_proof"
                return _signup(event, region, key)
            stage = "migration_payload"
            payload, raw = _payload(event, region)
            stage = "secret_lookup"
            key = _migration_key(region, arn)
            stage = "migration_request"
            user = _post(endpoint, raw, key)
            stage = "migration_response"
            return _response(event, payload, user)
    except Exception as error:
        # These labels are code constants, never event fields, exception
        # messages, email addresses, signatures, secrets or provider output.
        cause = "rejected" if isinstance(error, MigrationRejected) else "unavailable"
        if isinstance(error, _DeadlineExceeded):
            cause = "deadline"
        elif isinstance(error, _SecretSetupUnavailable):
            stage, cause = "secret_setup", "unavailable"
        _logger.error("migration_rejected stage=%s cause=%s", stage, cause)
        # Suppress exception chaining: network/SDK/parser exceptions can carry
        # raw request data. Runtime logs get only this fixed, generic message.
        raise MigrationRejected(FAILURE) from None


_secret_client = _initialize_secret_client()
