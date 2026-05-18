import { z } from 'zod';

export const CARRIERS = ['verizon', 'att', 'tmobile'] as const;
export type Carrier = (typeof CARRIERS)[number];

export const CARRIER_LABELS: Record<Carrier, string> = {
  verizon: 'Verizon',
  att: 'AT&T',
  tmobile: 'T-Mobile',
};

export const CarrierSchema = z.enum(CARRIERS);

export const ConnectionStatusSchema = z.enum([
  'disconnected',
  'connected',
  'error',
]);
export type ConnectionStatus = z.infer<typeof ConnectionStatusSchema>;

export interface CarrierConnection {
  carrier: Carrier;
  status: ConnectionStatus;
  accountLabel: string | null;
  lastError: string | null;
  lastSyncedAt: string | null;
}
