import type { Template } from '@/server/store/types';
import type { RecipeMetadata } from './recipe-metadata';

export type TemplateDto = Template & { recipe: RecipeMetadata | null };
