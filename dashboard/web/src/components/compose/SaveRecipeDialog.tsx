'use client';
import * as React from 'react';
import { Button, Dialog, Field, Input, Textarea } from '@/components/ui';
import { useT } from '@/lib/i18n';

export interface SaveRecipeDialogProps {
  open: boolean;
  saving?: boolean;
  onSave: (title: string, description: string) => void;
  onCancel: () => void;
}

export function SaveRecipeDialog({ open, saving, onSave, onCancel }: SaveRecipeDialogProps) {
  const t = useT('compose');
  const [title, setTitle] = React.useState('');
  const [description, setDescription] = React.useState('');

  // Reset the form each time the dialog opens.
  React.useEffect(() => {
    if (open) { setTitle(''); setDescription(''); }
  }, [open]);

  const canSave = title.trim().length > 0 && !saving;
  const submit = () => { if (canSave) onSave(title.trim(), description.trim()); };

  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={t('saveRecipeTitle')}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={saving}>{t('cancel')}</Button>
          <Button variant="primary" onClick={submit} disabled={!canSave} loading={saving}>{t('save')}</Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label={t('recipeName')}>
          <Input value={title} maxLength={80} placeholder={t('recipeNamePlaceholder')} autoFocus onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label={t('recipeDescription')}>
          <Textarea value={description} maxLength={400} rows={3} onChange={(e) => setDescription(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}
