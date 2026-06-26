'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';

export interface TermsEditorValue {
  plan_name: string | null;
  contracted_monthly_rate_cents: number | null;
  discount_percentage_bps: number | null;
  promo_credit_cents: number | null;
  promo_duration_months: number | null;
  device_credit_terms: string | null;
  line_minimums: number | null;
  upgrade_fee_rules: string | null;
  activation_fee_rules: string | null;
  international_package_terms: string | null;
  early_termination_terms: string | null;
  notes: string | null;
}

export interface TermsEditorProps {
  contractId: string;
  initial: TermsEditorValue;
  canReextract: boolean;
}

type FormValue = Record<string, string>;

function toFormValue(initial: TermsEditorValue): FormValue {
  return {
    plan_name: initial.plan_name ?? '',
    contracted_monthly_rate_dollars:
      initial.contracted_monthly_rate_cents === null
        ? ''
        : (initial.contracted_monthly_rate_cents / 100).toFixed(2),
    discount_percentage:
      initial.discount_percentage_bps === null
        ? ''
        : (initial.discount_percentage_bps / 100).toString(),
    promo_credit_dollars:
      initial.promo_credit_cents === null ? '' : (initial.promo_credit_cents / 100).toFixed(2),
    promo_duration_months:
      initial.promo_duration_months === null ? '' : String(initial.promo_duration_months),
    device_credit_terms: initial.device_credit_terms ?? '',
    line_minimums: initial.line_minimums === null ? '' : String(initial.line_minimums),
    upgrade_fee_rules: initial.upgrade_fee_rules ?? '',
    activation_fee_rules: initial.activation_fee_rules ?? '',
    international_package_terms: initial.international_package_terms ?? '',
    early_termination_terms: initial.early_termination_terms ?? '',
    notes: initial.notes ?? '',
  };
}

function parseDollarsToCents(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const num = Number.parseFloat(trimmed);
  if (!Number.isFinite(num)) return NaN;
  return Math.round(num * 100);
}

function parsePercentToBps(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const num = Number.parseFloat(trimmed);
  if (!Number.isFinite(num)) return NaN;
  return Math.round(num * 100);
}

function parseIntField(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const num = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(num)) return NaN;
  return num;
}

function nullableText(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export function TermsEditor({
  contractId,
  initial,
  canReextract,
}: TermsEditorProps): React.JSX.Element {
  const router = useRouter();
  const [form, setForm] = React.useState<FormValue>(() => toFormValue(initial));
  const [saving, setSaving] = React.useState(false);
  const [reextracting, setReextracting] = React.useState(false);

  const handleField =
    (key: keyof FormValue) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const value = e.target.value;
      setForm((prev) => ({ ...prev, [key]: value }));
    };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (saving) return;

    const rate = parseDollarsToCents(form.contracted_monthly_rate_dollars ?? '');
    const discount = parsePercentToBps(form.discount_percentage ?? '');
    const promo = parseDollarsToCents(form.promo_credit_dollars ?? '');
    const promoMonths = parseIntField(form.promo_duration_months ?? '');
    const lineMin = parseIntField(form.line_minimums ?? '');

    if (
      Number.isNaN(rate) ||
      Number.isNaN(discount) ||
      Number.isNaN(promo) ||
      Number.isNaN(promoMonths) ||
      Number.isNaN(lineMin)
    ) {
      toast.error('Numeric fields must be valid numbers.');
      return;
    }

    setSaving(true);
    try {
      const res = await fetch(`/api/contracts/${contractId}/terms`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          plan_name: nullableText(form.plan_name ?? ''),
          contracted_monthly_rate_cents: rate,
          discount_percentage_bps: discount,
          promo_credit_cents: promo,
          promo_duration_months: promoMonths,
          device_credit_terms: nullableText(form.device_credit_terms ?? ''),
          line_minimums: lineMin,
          upgrade_fee_rules: nullableText(form.upgrade_fee_rules ?? ''),
          activation_fee_rules: nullableText(form.activation_fee_rules ?? ''),
          international_package_terms: nullableText(form.international_package_terms ?? ''),
          early_termination_terms: nullableText(form.early_termination_terms ?? ''),
          notes: nullableText(form.notes ?? ''),
        }),
      });
      const body: unknown = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg =
          typeof body === 'object' &&
          body !== null &&
          'error' in body &&
          typeof (body as { error: unknown }).error === 'string'
            ? (body as { error: string }).error
            : 'Failed to save.';
        throw new Error(msg);
      }
      toast.success('Saved.');
      router.refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save.';
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const handleReextract = async () => {
    if (reextracting) return;
    setReextracting(true);
    try {
      const res = await fetch(`/api/contracts/${contractId}/start`, {
        method: 'POST',
      });
      const body: unknown = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg =
          typeof body === 'object' &&
          body !== null &&
          'error' in body &&
          typeof (body as { error: unknown }).error === 'string'
            ? (body as { error: string }).error
            : 'Failed to re-extract.';
        throw new Error(msg);
      }
      toast.success('Re-extraction started.');
      router.refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to re-extract.';
      toast.error(message);
    } finally {
      setReextracting(false);
    }
  };

  const Label = (props: { children: React.ReactNode; htmlFor: string }): React.JSX.Element => (
    <label
      htmlFor={props.htmlFor}
      className="block text-xs font-medium tracking-wide text-neutral-500 uppercase"
    >
      {props.children}
    </label>
  );

  const Input = (props: {
    id: string;
    name: keyof FormValue;
    placeholder?: string;
    type?: 'text' | 'number';
  }): React.JSX.Element => (
    <input
      id={props.id}
      type={props.type ?? 'text'}
      value={form[props.name] ?? ''}
      onChange={handleField(props.name)}
      placeholder={props.placeholder}
      className="mt-1 block h-9 w-full rounded-md border border-neutral-300 bg-white px-3 text-sm text-neutral-900 placeholder:text-neutral-400 focus-visible:ring-2 focus-visible:ring-neutral-900 focus-visible:ring-offset-2 focus-visible:outline-none"
    />
  );

  const Textarea = (props: {
    id: string;
    name: keyof FormValue;
    placeholder?: string;
    rows?: number;
  }): React.JSX.Element => (
    <textarea
      id={props.id}
      value={form[props.name] ?? ''}
      onChange={handleField(props.name)}
      placeholder={props.placeholder}
      rows={props.rows ?? 3}
      className="mt-1 block w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 focus-visible:ring-2 focus-visible:ring-neutral-900 focus-visible:ring-offset-2 focus-visible:outline-none"
    />
  );

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div>
          <Label htmlFor="plan_name">Plan name</Label>
          <Input id="plan_name" name="plan_name" placeholder="Business Unlimited Pro 2.0" />
        </div>
        <div>
          <Label htmlFor="contracted_monthly_rate_dollars">Contracted monthly rate ($)</Label>
          <Input
            id="contracted_monthly_rate_dollars"
            name="contracted_monthly_rate_dollars"
            placeholder="45.00"
          />
        </div>
        <div>
          <Label htmlFor="discount_percentage">Discount (%)</Label>
          <Input id="discount_percentage" name="discount_percentage" placeholder="12.5" />
        </div>
        <div>
          <Label htmlFor="line_minimums">Line minimums</Label>
          <Input id="line_minimums" name="line_minimums" placeholder="100" />
        </div>
        <div>
          <Label htmlFor="promo_credit_dollars">Promo credit ($/mo)</Label>
          <Input id="promo_credit_dollars" name="promo_credit_dollars" placeholder="10.00" />
        </div>
        <div>
          <Label htmlFor="promo_duration_months">Promo duration (months)</Label>
          <Input id="promo_duration_months" name="promo_duration_months" placeholder="24" />
        </div>
      </div>

      <div>
        <Label htmlFor="device_credit_terms">Device credit terms</Label>
        <Textarea id="device_credit_terms" name="device_credit_terms" />
      </div>
      <div>
        <Label htmlFor="upgrade_fee_rules">Upgrade fee rules</Label>
        <Textarea id="upgrade_fee_rules" name="upgrade_fee_rules" />
      </div>
      <div>
        <Label htmlFor="activation_fee_rules">Activation fee rules</Label>
        <Textarea id="activation_fee_rules" name="activation_fee_rules" />
      </div>
      <div>
        <Label htmlFor="international_package_terms">International package terms</Label>
        <Textarea id="international_package_terms" name="international_package_terms" />
      </div>
      <div>
        <Label htmlFor="early_termination_terms">Early termination terms</Label>
        <Textarea id="early_termination_terms" name="early_termination_terms" />
      </div>
      <div>
        <Label htmlFor="notes">Notes</Label>
        <Textarea id="notes" name="notes" rows={4} />
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-neutral-200 pt-4">
        <Button
          type="button"
          variant="outline"
          onClick={handleReextract}
          disabled={!canReextract || reextracting}
        >
          {reextracting ? 'Re-extracting…' : 'Re-extract'}
        </Button>
        <Button type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Save changes'}
        </Button>
      </div>
    </form>
  );
}
