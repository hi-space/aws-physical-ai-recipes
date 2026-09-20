import { defineMessages } from '../define';

export const compose = defineMessages({
  en: {
    // Page shell
    pageTitle: 'Build a pipeline',
    pageDescription: 'Chain recipes on a canvas, then save it as a recipe or run it.',
    // Palette
    palette: 'Blocks',
    paletteHint: 'Drag a block onto the canvas.',
    datasetSource: 'Dataset source',
    datasetSourceHint: 'A registered dataset feeding a recipe input.',
    gpuBadge: 'GPU',
    // Canvas
    canvasEmpty: 'Drag a recipe or dataset from the left to start.',
    deleteNode: 'Delete block',
    datasetUnset: 'Select a dataset',
    datasetVersion: 'v{version}',
    unverifiedKind: 'Kind is unverified — connectable to any input.',
    outputKind: 'Output kind',
    // Inspector
    inspectorEmpty: 'Select a block to edit its parameters.',
    parameters: 'Parameters',
    boundFromNode: '← {title} output',
    boundFromDataset: '← dataset {name}',
    boundHelp: 'Provided by an upstream connection.',
    titleLabel: 'Block name',
    // Footer / actions
    ready: 'Ready to save or run.',
    errorCount: '{count} problem(s) to resolve',
    validating: 'Validating…',
    serverValid: 'Validated by the server.',
    serverInvalid: 'Server validation failed.',
    saveRecipe: 'Save as recipe',
    runComposed: 'Run',
    // Save dialog
    saveRecipeTitle: 'Save as recipe',
    recipeName: 'Name',
    recipeDescription: 'Description',
    recipeNamePlaceholder: 'My pipeline',
    save: 'Save',
    cancel: 'Cancel',
    saved: 'Recipe saved.',
    // Connection rejection reasons
    rejectSelf: 'A block cannot connect to itself.',
    rejectIncomplete: 'Both ends of the connection are required.',
    rejectUnknownPort: 'That port no longer exists.',
    rejectKindMismatch: 'Port kinds do not match.',
    rejectInputBound: 'That input is already connected.',
    // Port kind labels (spec §3.1)
    portKindLerobotDataset: 'LeRobot dataset',
    portKindCheckpoint: 'Checkpoint',
    portKindVideo: 'Video',
    portKindSdgFrames: 'SDG frames',
    portKindHdf5Demos: 'HDF5 demos',
    portKindArtifacts: 'Artifacts',
    // Port legend & palette I/O
    legendTitle: 'Port kinds',
    legendHint: 'Only same-kind ports connect. Drag from a port to see where it fits.',
    paletteInputs: 'Takes',
    paletteOutputs: 'Gives',
    paletteNoInputs: 'nothing — starts a pipeline',
  },
  ko: {
    // Page shell
    pageTitle: '파이프라인 조립',
    pageDescription: '캔버스에서 레시피를 연결하고 레시피로 저장하거나 실행하세요.',
    // Palette
    palette: '블록',
    paletteHint: '블록을 캔버스로 끌어다 놓으세요.',
    datasetSource: '데이터셋 소스',
    datasetSourceHint: '레시피 입력에 연결할 등록된 데이터셋입니다.',
    gpuBadge: 'GPU',
    // Canvas
    canvasEmpty: '왼쪽에서 레시피나 데이터셋을 끌어다 놓아 시작하세요.',
    deleteNode: '블록 삭제',
    datasetUnset: '데이터셋 선택',
    datasetVersion: 'v{version}',
    unverifiedKind: '종류가 확인되지 않아 모든 입력에 연결할 수 있습니다.',
    outputKind: '출력 종류',
    // Inspector
    inspectorEmpty: '블록을 선택하면 파라미터를 편집할 수 있습니다.',
    parameters: '파라미터',
    boundFromNode: '← {title} 출력',
    boundFromDataset: '← 데이터셋 {name}',
    boundHelp: '업스트림 연결에서 제공됩니다.',
    titleLabel: '블록 이름',
    // Footer / actions
    ready: '저장하거나 실행할 수 있습니다.',
    errorCount: '해결할 문제 {count}건',
    validating: '검증 중…',
    serverValid: '서버 검증을 통과했습니다.',
    serverInvalid: '서버 검증에 실패했습니다.',
    saveRecipe: '레시피로 저장',
    runComposed: '실행',
    // Save dialog
    saveRecipeTitle: '레시피로 저장',
    recipeName: '이름',
    recipeDescription: '설명',
    recipeNamePlaceholder: '내 파이프라인',
    save: '저장',
    cancel: '취소',
    saved: '레시피를 저장했습니다.',
    // Connection rejection reasons
    rejectSelf: '블록은 자기 자신에 연결할 수 없습니다.',
    rejectIncomplete: '연결의 양쪽 끝이 모두 필요합니다.',
    rejectUnknownPort: '해당 포트가 더 이상 존재하지 않습니다.',
    rejectKindMismatch: '포트 종류가 일치하지 않습니다.',
    rejectInputBound: '해당 입력은 이미 연결되어 있습니다.',
    // Port kind labels (spec §3.1)
    portKindLerobotDataset: 'LeRobot 데이터셋',
    portKindCheckpoint: '체크포인트',
    portKindVideo: '비디오',
    portKindSdgFrames: 'SDG 프레임',
    portKindHdf5Demos: 'HDF5 데모',
    portKindArtifacts: '아티팩트',
    // Port legend & palette I/O
    legendTitle: '포트 종류',
    legendHint: '같은 종류의 포트끼리만 연결됩니다. 포트를 끌어보면 연결 가능한 곳이 강조됩니다.',
    paletteInputs: '받음',
    paletteOutputs: '내보냄',
    paletteNoInputs: '없음 · 시작 블록',
  },
});
