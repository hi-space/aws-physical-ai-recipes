# shellcheck shell=bash
# shellcheck disable=SC1091
source "${ROOT_DIR}/scripts/common.sh"

disabled="$(osmo_gateway_values_block "false")"
assert_contains "${disabled}" 'oauth2Proxy:'          'disabled has oauth2Proxy key'
assert_contains "${disabled}" 'enabled: false'        'disabled oauth2Proxy false'
assert_contains "${disabled}" 'tls:'                  'disabled has tls key'
assert_not_contains "${disabled}" 'provider: oidc'    'disabled has no oidc provider'

enabled="$(osmo_gateway_values_block "true")"
assert_contains "${enabled}" 'provider: oidc'         'enabled oauth2Proxy oidc'
assert_contains "${enabled}" 'tls:'                   'enabled has tls'
assert_contains "${enabled}" 'ingressClass: alb'      'enabled envoy alb ingress'
