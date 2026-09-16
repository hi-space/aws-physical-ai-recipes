import base64
import hashlib
import hmac
import json
import unittest
from verifier import verify


def token(claims, key="k" * 64):
    body = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
    signature = base64.urlsafe_b64encode(hmac.new(key.encode(), f"v1.{body}".encode(), hashlib.sha256).digest()).decode().rstrip("=")
    return f"v1.{body}.{signature}"


class VerifierTests(unittest.TestCase):
    def test_registered_identity_and_expiry(self):
        claims = {"aud": "pai-dcv", "sessionId": "console", "user": "ubuntu", "iat": 1000, "exp": 1120, "nonce": "one"}
        value = token(claims)
        self.assertTrue(verify(value, "k" * 64, "console", "ubuntu", 1001))
        self.assertFalse(verify(value, "k" * 64, "other", "ubuntu", 1001))
        self.assertFalse(verify(value, "k" * 64, "console", "other", 1001))
        self.assertFalse(verify(value, "k" * 64, "console", "ubuntu", 1120))
        self.assertFalse(verify(value, "z" * 64, "console", "ubuntu", 1001))
        self.assertFalse(verify(token({**claims, "aud": "pai-runtime"}), "k" * 64, "console", "ubuntu", 1001))


if __name__ == "__main__":
    unittest.main()
