/**
 * Message catalog. One module per page or component group; `useT('<namespace>')` types its keys from the `en` set.
 * Add a namespace here once, then fill both locales in its module.
 */
import { common } from './common';
import { nav } from './nav';
import { overview } from './overview';
import { workflows } from './workflows';
import { workflowDetail } from './workflowDetail';
import { newWorkflow } from './newWorkflow';
import { artifacts } from './artifacts';
import { taskConnections } from './taskConnections';
import { logs } from './logs';
import { dag } from './dag';
import { datasets } from './datasets';
import { datasetDetail } from './datasetDetail';
import { models } from './models';
import { experiments } from './experiments';
import { storage } from './storage';
import { compute } from './compute';
import { queues } from './queues';
import { jobs } from './jobs';
import { metrics } from './metrics';
import { usage } from './usage';
import { scaling } from './scaling';
import { admin } from './admin';
import { projects } from './projects';
import { access } from './access';
import { backends } from './backends';
import { imageProfiles } from './imageProfiles';
import { executionProfiles } from './executionProfiles';
import { builds } from './builds';
import { webhooks } from './webhooks';
import { edge } from './edge';
import { pipelines } from './pipelines';
import { sessions } from './sessions';
import { resources } from './resources';
import { resourcesPage } from './resourcesPage';
import { login } from './login';
import { compose } from './compose';

export const catalog = {
  common,
  nav,
  overview,
  workflows,
  workflowDetail,
  newWorkflow,
  artifacts,
  taskConnections,
  logs,
  dag,
  datasets,
  datasetDetail,
  models,
  experiments,
  storage,
  compute,
  queues,
  jobs,
  metrics,
  usage,
  scaling,
  admin,
  projects,
  access,
  backends,
  imageProfiles,
  executionProfiles,
  builds,
  webhooks,
  edge,
  pipelines,
  sessions,
  resources,
  resourcesPage,
  login,
  compose,
} as const;

export type Catalog = typeof catalog;
export type Namespace = keyof Catalog;
export type MessageKey<NS extends Namespace> = keyof Catalog[NS]['en'] & string;
