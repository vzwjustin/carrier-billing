'use client';

/**
 * Inventory filter form. Submits as GET to /inventory so the URL stays
 * shareable and the page re-renders server-side with the new filters.
 * Pure HTML controls — no shadcn / no client-state machinery — so the
 * server component remains the source of truth for filter state.
 */

import Link from 'next/link';
import * as React from 'react';

import { Button } from '@/components/ui/button';

export interface InventoryFiltersValue {
  q: string;
  carrier: string;
  account: string;
  deviceType: string;
  status: string;
}

export interface InventoryFiltersProps {
  initial: InventoryFiltersValue;
  /** Distinct account_last4 values present in the user's data. */
  accountOptions: ReadonlyArray<string>;
  /** Whether any non-default filter is currently applied. */
  filtersActive: boolean;
}

const CARRIER_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: 'All carriers' },
  { value: 'verizon', label: 'Verizon' },
  { value: 'att', label: 'AT&T' },
  { value: 'tmobile', label: 'T-Mobile' },
  { value: 'unknown', label: 'Unknown' },
];

const DEVICE_TYPE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: 'All device types' },
  { value: 'phone', label: 'Phone' },
  { value: 'tablet', label: 'Tablet' },
  { value: 'watch', label: 'Watch' },
  { value: 'hotspot', label: 'Hotspot' },
  { value: 'router', label: 'Router' },
  { value: 'other', label: 'Other' },
];

const STATUS_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: 'Any status' },
  { value: 'active', label: 'Active' },
  { value: 'suspended', label: 'Suspended' },
];

export function InventoryFilters({
  initial,
  accountOptions,
  filtersActive,
}: InventoryFiltersProps): React.JSX.Element {
  return (
    <form
      method="get"
      action="/inventory"
      className="grid gap-3 rounded-lg border border-neutral-200 bg-white p-3 sm:grid-cols-2 lg:grid-cols-6"
    >
      <label className="lg:col-span-2">
        <span className="sr-only">Search</span>
        <input
          type="text"
          name="q"
          defaultValue={initial.q}
          placeholder="Search device, plan, or MDN…"
          maxLength={80}
          className="block h-9 w-full rounded-md border border-neutral-300 bg-white px-3 text-sm text-neutral-900 placeholder:text-neutral-400 focus-visible:ring-2 focus-visible:ring-neutral-900 focus-visible:ring-offset-2 focus-visible:outline-none"
        />
      </label>

      <label>
        <span className="sr-only">Filter by carrier</span>
        <select
          name="carrier"
          defaultValue={initial.carrier}
          className="block h-9 w-full rounded-md border border-neutral-300 bg-white px-3 text-sm text-neutral-900 focus-visible:ring-2 focus-visible:ring-neutral-900 focus-visible:ring-offset-2 focus-visible:outline-none"
        >
          {CARRIER_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </label>

      <label>
        <span className="sr-only">Filter by account</span>
        <select
          name="account"
          defaultValue={initial.account}
          className="block h-9 w-full rounded-md border border-neutral-300 bg-white px-3 text-sm text-neutral-900 focus-visible:ring-2 focus-visible:ring-neutral-900 focus-visible:ring-offset-2 focus-visible:outline-none"
        >
          <option value="">All accounts</option>
          {accountOptions.map((acct) => (
            <option key={acct} value={acct}>
              *{acct}
            </option>
          ))}
        </select>
      </label>

      <label>
        <span className="sr-only">Filter by device type</span>
        <select
          name="deviceType"
          defaultValue={initial.deviceType}
          className="block h-9 w-full rounded-md border border-neutral-300 bg-white px-3 text-sm text-neutral-900 focus-visible:ring-2 focus-visible:ring-neutral-900 focus-visible:ring-offset-2 focus-visible:outline-none"
        >
          {DEVICE_TYPE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </label>

      <label>
        <span className="sr-only">Filter by status</span>
        <select
          name="status"
          defaultValue={initial.status}
          className="block h-9 w-full rounded-md border border-neutral-300 bg-white px-3 text-sm text-neutral-900 focus-visible:ring-2 focus-visible:ring-neutral-900 focus-visible:ring-offset-2 focus-visible:outline-none"
        >
          {STATUS_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </label>

      <div className="flex items-center gap-2 sm:col-span-2 lg:col-span-6">
        <Button type="submit" size="sm">
          Apply
        </Button>
        {filtersActive ? (
          <Link
            href="/inventory"
            className="inline-flex h-8 items-center justify-center rounded-md px-3 text-xs font-medium text-neutral-900 hover:bg-neutral-100"
          >
            Clear
          </Link>
        ) : null}
      </div>
    </form>
  );
}
