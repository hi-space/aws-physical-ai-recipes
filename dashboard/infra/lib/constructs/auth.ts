import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

export interface AuthConstructProps {
  accountId: string;
  /** HTTPS ingress mode uses the ALB authenticate-cognito client + managed-login branding; HTTP uses in-app password login. */
  mode: 'https' | 'http';
  /** Required in https mode (callback/logout URLs, admin loginUrl); unused in http mode. */
  domainName?: string;
  adminUsername: string;
  adminEmail: string;
}

/**
 * Cognito user pool + hosted UI, the three RBAC groups, and a bootstrap admin whose
 * permanent password lives in Secrets Manager (no email round-trip needed).
 *
 * Two client shapes:
 *   - `userPoolClient` ('alb', https only): confidential client for ALB authenticate-cognito
 *     plus the managed-login (branding v2) theme.
 *   - `appClient` ('app', both modes): public client with USER_PASSWORD/USER_SRP flows for the
 *     web app's in-app Cognito login (AUTH_MODE=cognito, HTTP deployments).
 */
export class AuthConstruct extends Construct {
  readonly userPool: cognito.UserPool;
  /** ALB authenticate-cognito client; only created in https mode. */
  readonly userPoolClient?: cognito.UserPoolClient;
  readonly userPoolDomain: cognito.UserPoolDomain;
  /** Secret-less app client for in-app InitiateAuth login; created in both modes. */
  readonly appClient: cognito.UserPoolClient;
  readonly adminSecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: AuthConstructProps) {
    super(scope, id);

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `physical-ai-dashboard-${props.accountId}`,
      selfSignUpEnabled: false,
      signInAliases: { username: true, email: true },
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      passwordPolicy: { minLength: 8, requireLowercase: true, requireUppercase: true, requireDigits: true, requireSymbols: false, tempPasswordValidity: cdk.Duration.days(7) },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      deletionProtection: true,
      // Managed login (branding v2) requires Essentials or Plus; Lite only has the classic hosted UI.
      featurePlan: cognito.FeaturePlan.ESSENTIALS,
    });

    for (const [name, description, precedence] of [
      ['admins', 'Full access: clusters, quotas, users, edge deployments', 1],
      ['researchers', 'Submit/cancel workflows, datasets, sessions, uploads', 5],
      ['viewers', 'Read-only', 10],
    ] as const) {
      new cognito.CfnUserPoolGroup(this, `Group-${name}`, { userPoolId: this.userPool.userPoolId, groupName: name, description, precedence });
    }

    this.userPoolDomain = this.userPool.addDomain('Domain', {
      cognitoDomain: { domainPrefix: `physical-ai-${props.accountId}` },
      // v2 = managed login (enables the branding style below); v1 is the classic hosted UI.
      managedLoginVersion: cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN,
    });

    // Secret-less public client for the web app's in-app InitiateAuth login (AUTH_MODE=cognito).
    // Created in BOTH modes; it is the only client in http mode.
    this.appClient = this.userPool.addClient('AppClient', {
      userPoolClientName: 'app',
      generateSecret: false,
      authFlows: { userPassword: true, userSrp: true },
      // Direct InitiateAuth only — no hosted-UI OAuth flows/callbacks on this public client.
      disableOAuth: true,
      preventUserExistenceErrors: true,
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(30),
    });

    // ALB authenticate-cognito client + managed-login branding are https-only.
    if (props.mode === 'https') {
    this.userPoolClient = this.userPool.addClient('AlbClient', {
      userPoolClientName: 'alb',
      generateSecret: true,
      authFlows: { userSrp: true },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: [`https://${props.domainName}/oauth2/idpresponse`],
        logoutUrls: [`https://${props.domainName}/`],
      },
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
      preventUserExistenceErrors: true,
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(30),
    });

    // ---- managed login (branding v2) themed to the dashboard's dark palette (web/src/app/globals.css).
    // Colours are RRGGBBAA. colorSchemeMode=DARK renders the darkMode values; lightMode values are the
    // Cognito defaults, kept for completeness (never shown while the mode is DARK). Mirror of auth.tf.
    const c = {
      bg: '0b0e14ff', bgElev: '111622ff', bgElev2: '171d2bff', border: '232b3bff', borderStr: '33405aff',
      fg: 'e6e9f0ff', fgMuted: '98a2b8ff', fgFaint: '66718aff', accent: '6ea8feff', accentStr: '3b82f6ff',
    };
    new cognito.CfnManagedLoginBranding(this, 'AlbBranding', {
      userPoolId: this.userPool.userPoolId,
      clientId: this.userPoolClient.userPoolClientId,
      // settings alone applies the theme; Cognito fills every unspecified key with its defaults.
      settings: {
        categories: {
          global: { colorSchemeMode: 'DARK', pageHeader: { enabled: false }, pageFooter: { enabled: false }, spacingDensity: 'REGULAR' },
          form: { displayGraphics: true, location: { horizontal: 'CENTER', vertical: 'CENTER' } },
        },
        components: {
          pageBackground: { image: { enabled: false }, darkMode: { color: c.bg }, lightMode: { color: 'ffffffff' } },
          pageText: {
            darkMode: { headingColor: c.fg, bodyColor: c.fgMuted, descriptionColor: c.fgMuted },
            lightMode: { headingColor: '000716ff', bodyColor: '414d5cff', descriptionColor: '414d5cff' },
          },
          form: {
            borderRadius: 12,
            backgroundImage: { enabled: false },
            logo: { enabled: false, location: 'CENTER', position: 'TOP', formInclusion: 'IN' },
            darkMode: { backgroundColor: c.bgElev, borderColor: c.border },
            lightMode: { backgroundColor: 'ffffffff', borderColor: 'c6c6cdff' },
          },
          primaryButton: {
            darkMode: {
              defaults: { backgroundColor: c.accentStr, textColor: 'ffffffff' },
              hover: { backgroundColor: c.accent, textColor: c.bg },
              active: { backgroundColor: c.accent, textColor: c.bg },
              disabled: { backgroundColor: c.bgElev2, borderColor: c.border },
            },
            lightMode: {
              defaults: { backgroundColor: '0972d3ff', textColor: 'ffffffff' },
              hover: { backgroundColor: '033160ff', textColor: 'ffffffff' },
              active: { backgroundColor: '033160ff', textColor: 'ffffffff' },
              disabled: { backgroundColor: 'ffffffff', borderColor: 'ffffffff' },
            },
          },
          secondaryButton: {
            darkMode: {
              defaults: { backgroundColor: c.bgElev, borderColor: c.borderStr, textColor: c.accent },
              hover: { backgroundColor: c.bgElev2, borderColor: c.accent, textColor: c.accent },
              active: { backgroundColor: c.border, borderColor: c.accent, textColor: c.accent },
            },
            lightMode: {
              defaults: { backgroundColor: 'ffffffff', borderColor: '0972d3ff', textColor: '0972d3ff' },
              hover: { backgroundColor: 'f2f8fdff', borderColor: '033160ff', textColor: '033160ff' },
              active: { backgroundColor: 'd3e7f9ff', borderColor: '033160ff', textColor: '033160ff' },
            },
          },
        },
        componentClasses: {
          buttons: { borderRadius: 8 },
          input: {
            borderRadius: 8,
            darkMode: { defaults: { backgroundColor: c.bg, borderColor: c.borderStr }, placeholderColor: c.fgFaint },
            lightMode: { defaults: { backgroundColor: 'ffffffff', borderColor: '7d8998ff' }, placeholderColor: '5f6b7aff' },
          },
          inputLabel: { darkMode: { textColor: c.fg }, lightMode: { textColor: '000716ff' } },
          inputDescription: { darkMode: { textColor: c.fgMuted }, lightMode: { textColor: '5f6b7aff' } },
          link: {
            darkMode: { defaults: { textColor: c.accent }, hover: { textColor: c.accentStr } },
            lightMode: { defaults: { textColor: '0972d3ff' }, hover: { textColor: '033160ff' } },
          },
          focusState: { darkMode: { borderColor: c.accent }, lightMode: { borderColor: '0972d3ff' } },
          divider: { darkMode: { borderColor: c.border }, lightMode: { borderColor: 'ebebf0ff' } },
        },
      },
    });
    }

    // ---- bootstrap admin
    // The ALB DNS name is not known when Auth is built (the ALB lives in the sibling service
    // construct), so http mode records a placeholder pointing at the DashboardUrl output.
    const loginUrl = props.mode === 'https' ? `https://${props.domainName}/` : '(ALB DNS)/login — see the DashboardUrl stack output';
    this.adminSecret = new secretsmanager.Secret(this, 'AdminSecret', {
      secretName: `physical-ai-dashboard/${props.accountId}/admin`,
      description: 'Bootstrap admin login for the Physical AI Dashboard (Cognito)',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: props.adminUsername, email: props.adminEmail, loginUrl }),
        generateStringKey: 'password',
        passwordLength: 20,
        excludePunctuation: true,
        requireEachIncludedType: true,
      },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const password = this.adminSecret.secretValueFromJson('password').unsafeUnwrap(); // resolves as a CFN dynamic reference, not plaintext in the template

    const createUser = new cr.AwsCustomResource(this, 'AdminUser', {
      resourceType: 'Custom::CognitoBootstrapAdmin',
      onCreate: {
        service: 'CognitoIdentityServiceProvider',
        action: 'adminCreateUser',
        parameters: {
          UserPoolId: this.userPool.userPoolId,
          Username: props.adminUsername,
          MessageAction: 'SUPPRESS',
          TemporaryPassword: password,
          UserAttributes: [{ Name: 'email', Value: props.adminEmail }, { Name: 'email_verified', Value: 'true' }],
        },
        physicalResourceId: cr.PhysicalResourceId.of(`${this.userPool.userPoolId}/${props.adminUsername}`),
        ignoreErrorCodesMatching: 'UsernameExistsException',
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: [this.userPool.userPoolArn] }),
    });
    const setPassword = new cr.AwsCustomResource(this, 'AdminPassword', {
      resourceType: 'Custom::CognitoBootstrapAdminPassword',
      onCreate: {
        service: 'CognitoIdentityServiceProvider',
        action: 'adminSetUserPassword',
        parameters: { UserPoolId: this.userPool.userPoolId, Username: props.adminUsername, Password: password, Permanent: true },
        physicalResourceId: cr.PhysicalResourceId.of(`${this.userPool.userPoolId}/${props.adminUsername}/password`),
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: [this.userPool.userPoolArn] }),
    });
    setPassword.node.addDependency(createUser);
    const addToGroup = new cr.AwsCustomResource(this, 'AdminGroup', {
      resourceType: 'Custom::CognitoBootstrapAdminGroup',
      onCreate: {
        service: 'CognitoIdentityServiceProvider',
        action: 'adminAddUserToGroup',
        parameters: { UserPoolId: this.userPool.userPoolId, Username: props.adminUsername, GroupName: 'admins' },
        physicalResourceId: cr.PhysicalResourceId.of(`${this.userPool.userPoolId}/${props.adminUsername}/admins`),
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: [this.userPool.userPoolArn] }),
    });
    addToGroup.node.addDependency(createUser);
    addToGroup.node.addDependency(this.node.findChild('Group-admins'));
  }
}
