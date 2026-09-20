'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Input, LinkButton, Select, Spinner } from '@/components/ui';
import { useT } from '@/lib/i18n';
import { useApi } from '@/lib/api-client';
import { profileIdForImageEnv, requiredImageEnv } from '@/lib/workflow/builtin-images';
import type { ImageProfile } from '@/server/services/image-profiles';

export interface ImagePickerProps {
  value: string;
  onChange(value: string): void;
  disabled?: boolean;
}

const CUSTOM = '__custom__';

/**
 * Picks a task image from the project's approved, enabled image profiles (`GET /api/image-profiles`), with a
 * "enter manually" escape hatch for images that have no profile yet. A `required://<ENV>` default (the
 * deployment did not set that image variable) is resolved automatically when an administrator has approved
 * the matching seeded `builtin-*` profile; otherwise the placeholder stays until the user picks or types one,
 * and server validation keeps reporting the image as not ready.
 */
export function ImagePicker({ value, onChange, disabled }: ImagePickerProps) {
  const t = useT('newWorkflow');
  const tc = useT('common');
  const { data, isLoading, error } = useApi<{ profiles: ImageProfile[] }>('/api/image-profiles');

  const approved = useMemo(() => (data?.profiles ?? []).filter((p) => p.approved && p.enabled), [data]);
  const requiredEnv = requiredImageEnv(value);
  // The env named by the initial `required://` default, kept so clearing the select can restore it.
  const initialEnv = useRef(requiredEnv);
  const matched = approved.find((p) => p.image.requestedImage === value || p.image.resolvedImage === value);
  const [custom, setCustom] = useState(false);
  // Free text is the only way to show a value that is neither a placeholder nor an approved profile, and
  // the only way to enter one when there are no approved profiles or the list could not be loaded.
  const showInput = custom || (!!value && !requiredEnv && !matched && !isLoading) || (!isLoading && (!!error || approved.length === 0));

  // Resolve `required://<ENV>` once from the seeded `builtin-*` profile for that variable, if approved.
  const autoResolved = useRef(false);
  useEffect(() => {
    if (!requiredEnv || autoResolved.current || disabled) return;
    const id = profileIdForImageEnv(requiredEnv);
    const profile = id ? approved.find((p) => p.id === id) : undefined;
    if (profile) {
      autoResolved.current = true;
      onChange(profile.image.requestedImage);
    }
  }, [requiredEnv, approved, onChange, disabled]);

  if (isLoading) return <div className="flex items-center gap-2 text-sm text-fg-muted"><Spinner /> {t('imageProfilesLoading')}</div>;

  const selectValue = matched ? matched.id : showInput ? CUSTOM : '';
  const onSelect = (next: string) => {
    if (next === CUSTOM) { setCustom(true); return; }
    setCustom(false);
    if (next === '') { onChange(initialEnv.current ? `required://${initialEnv.current}` : ''); return; }
    const profile = approved.find((p) => p.id === next);
    if (profile) onChange(profile.image.requestedImage);
  };

  return (
    <div className="space-y-2" data-testid="image-picker">
      {!error && approved.length > 0 && (
        <Select value={selectValue} disabled={disabled} onChange={(e) => onSelect(e.target.value)} aria-label={t('paramImage')}>
          <option value="">{tc('select')}</option>
          {approved.map((p) => (
            <option key={p.id} value={p.id}>{`${p.name} · ${p.image.requestedImage}`}</option>
          ))}
          <option value={CUSTOM}>{t('imageCustom')}</option>
        </Select>
      )}
      {showInput && (
        <Input
          value={requiredEnv ? '' : value}
          disabled={disabled}
          placeholder={t('imageCustomPlaceholder')}
          onChange={(e) => onChange(e.target.value)}
          aria-label={t('imageCustom')}
        />
      )}
      {error && <div className="text-sm text-err">{t('imageProfilesLoadError')}</div>}
      {!error && approved.length === 0 && <div className="text-[12px] text-fg-muted">{t('imageNoProfiles')}</div>}
      {requiredEnv && <div className="text-[12px] text-warn">{t('imageRequiredHint', { env: requiredEnv })}</div>}
      {(requiredEnv || (!error && approved.length === 0)) && <LinkButton href="/image-profiles" size="sm">{t('imageProfilesLink')}</LinkButton>}
    </div>
  );
}
