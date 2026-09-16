import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

export interface AuthConstructProps {
  accountId: string;
  domainName: string;
  adminUsername: string;
  adminEmail: string;
}

/**
 * Cognito user pool + hosted UI + app client wired for ALB authenticate-cognito,
 * the three RBAC groups, and a bootstrap admin whose permanent password lives in
 * Secrets Manager (no email round-trip needed).
 */
export class AuthConstruct extends Construct {
  readonly userPool: cognito.UserPool;
  readonly userPoolClient: cognito.UserPoolClient;
  readonly userPoolDomain: cognito.UserPoolDomain;
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
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      deletionProtection: false,
    });

    for (const [name, description, precedence] of [
      ['admins', 'Full access: clusters, quotas, users, edge deployments', 1],
      ['researchers', 'Submit/cancel workflows, datasets, sessions, uploads', 5],
      ['viewers', 'Read-only', 10],
    ] as const) {
      new cognito.CfnUserPoolGroup(this, `Group-${name}`, { userPoolId: this.userPool.userPoolId, groupName: name, description, precedence });
    }

    this.userPoolDomain = this.userPool.addDomain('Domain', { cognitoDomain: { domainPrefix: `physical-ai-${props.accountId}` } });

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

    // ---- bootstrap admin
    this.adminSecret = new secretsmanager.Secret(this, 'AdminSecret', {
      secretName: `physical-ai-dashboard/${props.accountId}/admin`,
      description: 'Bootstrap admin login for the Physical AI Dashboard (Cognito)',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: props.adminUsername, email: props.adminEmail, loginUrl: `https://${props.domainName}/` }),
        generateStringKey: 'password',
        passwordLength: 20,
        excludePunctuation: true,
        requireEachIncludedType: true,
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
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
      onDelete: {
        service: 'CognitoIdentityServiceProvider',
        action: 'adminDeleteUser',
        parameters: { UserPoolId: this.userPool.userPoolId, Username: props.adminUsername },
        ignoreErrorCodesMatching: 'UserNotFoundException|ResourceNotFoundException',
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
