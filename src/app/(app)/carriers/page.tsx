import { listConnectionsAction } from './actions';

import { ConnectionsPanel } from '@/components/carriers/connections-panel';

export const metadata = {
  title: 'Carrier Connections — CarrierAudit',
};

export const dynamic = 'force-dynamic';

export default async function CarriersPage(): Promise<React.JSX.Element> {
  const connections = await listConnectionsAction();

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-100">
          Carrier connections
        </h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Link a carrier to pull bills automatically. Carriers expose no public billing API, so
          connection and sync run through a simulated adapter — uploading a PDF remains the source
          of truth for real audits.
        </p>
      </header>
      <ConnectionsPanel initial={connections} />
    </div>
  );
}
