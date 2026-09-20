import type { Project, ProjectRole } from './projects';
import type { Attachment } from './project-adoption';
export interface ProjectView extends Project { myRole?: ProjectRole; attachment: Attachment }
