import { defineMessages } from '../define';

export const login = defineMessages({
  en: {
    title: 'Sign in',
    description: 'Physical AI Dashboard',
    username: 'Username or email',
    password: 'Password',
    submit: 'Sign in',
    submitting: 'Signing in…',
    newPasswordTitle: 'Set a new password',
    newPassword: 'New password',
    newPasswordHelp: 'At least 8 characters with upper- and lowercase letters and a digit.',
    confirm: 'Save and sign in',
    failed: 'Sign-in failed. Check your username and password.',
    challengeFailed: 'The new password was not accepted.',
    networkError: 'The server could not be reached.',
  },
  ko: {
    title: '로그인',
    description: 'Physical AI Dashboard',
    username: '사용자 이름 또는 이메일',
    password: '비밀번호',
    submit: '로그인',
    submitting: '로그인 중…',
    newPasswordTitle: '새 비밀번호 설정',
    newPassword: '새 비밀번호',
    newPasswordHelp: '8자 이상, 대문자·소문자·숫자를 포함해야 합니다.',
    confirm: '저장하고 로그인',
    failed: '로그인에 실패했습니다. 사용자 이름과 비밀번호를 확인하세요.',
    challengeFailed: '새 비밀번호가 거부되었습니다.',
    networkError: '서버에 연결할 수 없습니다.',
  },
});
