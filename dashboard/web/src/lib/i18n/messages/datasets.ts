import { defineMessages } from '../define';

export const datasets = defineMessages({
  en: {
    title: 'Datasets', description: 'Manage data versions and track lineage.',
    resourceSource: 'DynamoDB dataset records · S3 ListObjectsV2 · HeadObject (data bucket)',
    loadingLegacy: 'Loading personal datasets…',
    showLegacy: 'View previous personal data', showDatasets: 'Show datasets',
    statDatasets: 'Datasets', statVersions: 'Total versions', statProduced: 'Produced by workflows',
    searchPlaceholder: 'Search datasets…', newDataset: 'New dataset', importHF: 'Import from HF',
    createTitle: 'Create dataset', createName: 'Name', createNameHelp: 'Lowercase DNS-1123 (a-z, 0-9, -), max 60 chars',
    createNamePlaceholder: 'my-dataset', createDesc: 'Description', createDescPlaceholder: 'What is this dataset?',
    createTags: 'Tags', createTagsHelp: 'Comma-separated', createTagsPlaceholder: 'training, v2, processed',
    createFormat: 'Format', createFormatNone: 'None',
    colName: 'Name', colDesc: 'Description', colLatest: 'Latest', colTags: 'Tags', colOwner: 'Owner', colUpdated: 'Updated',
    empty: 'No datasets', noMatches: 'No matches',
    toastCreated: 'Dataset created',
  },
  ko: {
    title: '데이터셋', description: '데이터 버전을 관리하고 계보를 추적합니다.',
    resourceSource: 'DynamoDB dataset records · S3 ListObjectsV2 · HeadObject (data bucket)',
    loadingLegacy: '개인 데이터를 불러오는 중…',
    showLegacy: '이전 개인 데이터 보기', showDatasets: '데이터셋 보기',
    statDatasets: '데이터셋', statVersions: '전체 버전', statProduced: '레시피에서 생성',
    searchPlaceholder: '데이터셋 검색…', newDataset: '새 데이터셋', importHF: 'HF에서 가져오기',
    createTitle: '데이터셋 생성', createName: '이름', createNameHelp: '영문 소문자 DNS-1123 형식 (a-z, 0-9, -), 최대 60자',
    createNamePlaceholder: 'my-dataset', createDesc: '설명', createDescPlaceholder: '이 데이터셋은 어떤 데이터인가요?',
    createTags: '태그', createTagsHelp: '쉼표로 구분', createTagsPlaceholder: 'training, v2, processed',
    createFormat: '형식', createFormatNone: '없음',
    colName: '이름', colDesc: '설명', colLatest: '최신', colTags: '태그', colOwner: '소유자', colUpdated: '수정',
    empty: '데이터셋 없음', noMatches: '일치하는 항목 없음',
    toastCreated: '데이터셋이 생성되었습니다',
  },
});
