import { defineMessages } from '../define';

export const webhooks = defineMessages({
  en: {
    // page header
    pageLabel: 'WORKFLOW EVENTS / DELIVERY LEDGER', title: 'Project webhooks', description: 'Event subscriptions and delivery history',
    badge: 'Signed events · Duplicates possible',
    // subscriptions section
    subscriptions: 'Subscriptions', noHooks: 'No webhooks registered.', noHooksHint: 'Project administrators can register receiver servers and signing keys.',
    subscriptionNote: 'Receiver URLs and signing keys are encrypted at rest and not returned. Registration and key rotation do not send test messages.',
    // delivery section
    deliveries: 'Delivery history', selectSubscription: 'Select a subscription.', recentDeliveries: 'Latest 50',
    noDeliveries: 'No delivery records yet.', deliveriesHint: 'Records appear after the worker connects and events match the subscription status.',
    // delivery status
    attempts: 'Attempt {attempts} · Total {total} · Redrive {redrive}',
    deliveryRetry: 'Schedule redrive with current settings', deliveryRetryNote: 'Event ID retained.',
    deliveryDisabled: 'Disable subscription', deliveryEnabled: 'Enable subscription',
    deliveryDisabledNote: 'Subscription stopped. Previous history and encryption settings retained.',
    deliveryEnabledNote: 'Subscription re-enabled.',
    // new subscription form
    newSubscription: 'Register new subscription', subscriptionName: 'Subscription name',
    receiverUrl: 'Receiver HTTPS URL', receiverPlaceholder: 'https://receiver.example.com/events',
    signingKey: 'Shared signing key', keyMinLength: '32+ characters', endpointStatuses: 'Completion statuses',
    statusSucceeded: 'SUCCEEDED', statusFailed: 'FAILED', statusCancelled: 'CANCELLED',
    subscriptionNote2: 'Use a random key with the receiver. Body contains only execution ID, project, name, completion status, and timestamp. Receivers must handle duplicates by event ID.',
    registerSubscription: 'Register subscription', registrationSuccess: 'Webhook registered. Signing key is not retrievable again.',
    // rotate form
    rotateTitle: 'Rotate signing key or receiver URL', newKey: 'New signing key', newUrl: 'New HTTPS URL (leave empty to keep existing)',
    rotateSubmit: 'Rotate encryption settings', rotateNote: 'Settings replaced. Pending deliveries tied to previous settings are cancelled. Manually redrive if needed.',
    rotateSuccess: 'Settings replaced. Pending deliveries tied to the previous settings are cancelled; redrive explicitly if needed.',
    redriveScheduled: 'Redrive scheduled with the current settings. The event ID is kept.',
  },
  ko: {
    pageLabel: 'WORKFLOW EVENTS / DELIVERY LEDGER', title: '프로젝트 웹훅', description: '종료 이벤트 구독과 전달 이력',
    badge: '서명된 이벤트 · 중복 수신 가능',
    subscriptions: '구독', noHooks: '등록된 웹훅이 없습니다.', noHooksHint: '프로젝트 관리자가 수신 서버와 공유 서명 키를 등록할 수 있습니다.',
    subscriptionNote: '수신 URL과 서명 키는 암호화 저장되며 조회 화면에 반환되지 않습니다. 등록·키 교체는 테스트 메시지를 보내지 않습니다.',
    deliveries: '전달 이력', selectSubscription: '구독을 선택하세요.', recentDeliveries: '최근 50건',
    noDeliveries: '아직 전달 기록이 없습니다.', deliveriesHint: 'worker 연결 후 구독 상태에 맞는 새 종료 이벤트가 기록됩니다.',
    attempts: '시도 {attempts}회 · 전체 {total}회 · 재전달 {redrive}회',
    deliveryRetry: '현재 설정으로 재전달 예약', deliveryRetryNote: '이벤트 ID는 유지됩니다.',
    deliveryDisabled: '구독 중지', deliveryEnabled: '구독 활성화',
    deliveryDisabledNote: '구독을 중지했습니다. 기존 이력과 암호화 설정은 보존됩니다.',
    deliveryEnabledNote: '구독을 다시 활성화했습니다.',
    newSubscription: '새 구독 등록', subscriptionName: '구독 이름',
    receiverUrl: '수신 HTTPS URL', receiverPlaceholder: 'https://receiver.example.com/events',
    signingKey: '공유 서명 키', keyMinLength: '32자 이상', endpointStatuses: '종료 상태',
    statusSucceeded: 'SUCCEEDED', statusFailed: 'FAILED', statusCancelled: 'CANCELLED',
    subscriptionNote2: '수신 서버와 같은 무작위 키를 사용하세요. 본문에는 실행 ID, 프로젝트, 이름, 종료 상태와 시각만 포함됩니다. 수신자는 이벤트 ID로 중복을 처리해야 합니다.',
    registerSubscription: '구독 등록', registrationSuccess: '웹훅을 등록했습니다. 서명 키는 다시 조회할 수 없습니다.',
    rotateTitle: '암호화 설정 교체 (키 또는 URL)', newKey: '새 서명 키', newUrl: '새 HTTPS URL (빈칸이면 기존 유지)',
    rotateSubmit: '암호화 설정 교체', rotateNote: '설정을 교체했습니다. 이전 설정에 묶인 대기 전달은 취소되며, 필요하면 명시적으로 재전달하세요.',
    rotateSuccess: '설정을 교체했습니다. 이전 설정에 묶인 대기 전달은 취소되며, 필요하면 명시적으로 재전달하세요.',
    redriveScheduled: '현재 설정으로 재전달을 예약했습니다. 이벤트 ID는 유지됩니다.',
  },
});
