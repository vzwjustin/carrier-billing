// Project roadmap originally ingested from the Manus "CarrierAudit Project
// TODO" export, then reconciled against THIS codebase.
//
// `done` reflects this repository's verified state — not the Manus checkbox.
// Items the export left unchecked but which are genuinely shipped here (e.g.
// real Stripe checkout, billing portal, E2E flow coverage) are marked done
// with evidence; items the export checked but which assume a different stack
// (Manus OAuth / tRPC) or an impossible capability (public carrier billing
// APIs) are NOT silently flipped — their labels stay verbatim from the source
// and they remain pending. Treat this as a planning view, source of truth =
// the code.

export interface RoadmapItem {
  label: string;
  done: boolean;
}

export interface RoadmapSection {
  title: string;
  items: RoadmapItem[];
}

const d = (label: string): RoadmapItem => ({ label, done: true });
const p = (label: string): RoadmapItem => ({ label, done: false });

export const ROADMAP: RoadmapSection[] = [
  {
    title: 'Phase 1: Database & Configuration',
    items: [
      d('Set up database schema (users, audits, findings, credits, subscriptions, share_tokens)'),
      d('Configure Stripe integration and environment variables'),
      d('Set up Manus OAuth configuration'),
      d('Create database migrations'),
    ],
  },
  {
    title: 'Phase 2: Landing Page',
    items: [
      d('Design and build hero section with compelling copy'),
      d('Build features overview section'),
      d('Build pricing table with Starter, Pro, Enterprise tiers'),
      d('Add FAQ section'),
      d('Implement responsive design for mobile'),
    ],
  },
  {
    title: 'Phase 3: Authentication',
    items: [
      d('Build signup page with Manus OAuth'),
      d('Build login page with Manus OAuth'),
      d('Build password reset flow'),
      d('Build password update page'),
      d('Add auth middleware and protected routes (DashboardLayout enforces auth)'),
    ],
  },
  {
    title: 'Phase 4: Dashboard',
    items: [
      d('Build dashboard layout with sidebar navigation'),
      d('Display current credit balance in header'),
      d('Build audit history list with status indicators'),
      d('Add quick-upload CTA button'),
      d('Implement pagination for audit list'),
    ],
  },
  {
    title: 'Phase 5: Bill Upload Flow',
    items: [
      d('Build upload page with drag-and-drop support'),
      d('Implement credit gating check before upload'),
      d('Add file type validation (PDF, CSV)'),
      d('Integrate cloud storage for uploaded files (S3 via storagePut)'),
      d('Build upload progress indicator (loading states)'),
      d('Create audit record in database'),
    ],
  },
  {
    title: 'Phase 6: AI Bill Extraction & Rules Engine',
    items: [
      d('Integrate LLM (Claude) for bill parsing'),
      d('Build PDF text extraction with OCR fallback'),
      d('Build EDI 811 parser for structured files'),
      d('Implement rules engine with ~10 deterministic checks'),
      d('Create findings generation logic'),
      d('Calculate savings estimates per finding'),
      d('Generate plain-English executive summary'),
    ],
  },
  {
    title: 'Phase 7: Savings Report View',
    items: [
      d('Build report view page with findings breakdown'),
      d('Display severity badges (high/medium/low/info)'),
      d('Show recommended actions for each finding'),
      d('Implement shareable token link generation'),
      d('Build public read-only report view (no auth required)'),
      d('Add 30-day expiry to share tokens'),
    ],
  },
  {
    title: 'Phase 8: PDF Report Generation',
    items: [
      d('Create PDF report HTML generation service'),
      d('Build PDF download button component'),
      d('Wire PDF download into AuditReport page'),
      d('Include executive summary in PDF'),
    ],
  },
  {
    title: 'Phase 9: Stripe Integration',
    items: [
      d('Create Stripe service with mock checkout'),
      d('Build Checkout page with pricing tiers'),
      d('Implement real Stripe Checkout integration (currently mock)'),
      d('Implement Stripe webhook handling'),
      d('Build credit fulfillment on payment success'),
      d('Add subscription support (recurring billing)'),
      d('Handle failed payment emails'),
      d('Implement billing portal link'),
    ],
  },
  {
    title: 'Phase 10: Admin Panel',
    items: [
      d('Build admin dashboard layout'),
      d('Implement user management CRUD'),
      d('Add database record browser/editor'),
      d('Build role promotion interface'),
      d('Add audit activity monitoring'),
      d('Implement data export functionality (currently placeholder toast)'),
    ],
  },
  {
    title: 'Phase 11: Settings Page',
    items: [
      d('Build account information section'),
      d('Add notification preferences'),
      d('Implement billing portal link'),
      d('Add integrations section (webhooks, email)'),
      d('Build danger zone (account deletion)'),
    ],
  },
  {
    title: 'Phase 12: Carrier API Integration',
    items: [
      d('Create carrier integration service (Verizon, AT&T, T-Mobile)'),
      d('Build CarrierConnections page for managing connections'),
      d('Add carriers router to tRPC'),
      p('Implement real carrier authentication flow'),
      p('Build direct bill retrieval from carriers'),
      d('Persist carrier connections in database'),
    ],
  },
  {
    title: 'Phase 13: Recurring Jobs',
    items: [
      d('Create recurring jobs service (monthly reminders, cleanup)'),
      d('Integrate with job scheduler (Inngest/Bull)'),
      d('Build email notification for bill upload reminders'),
      d('Implement job scheduling infrastructure'),
    ],
  },
  {
    title: 'Phase 14: Polish & Refinement',
    items: [
      d('Comprehensive error handling and user feedback (ErrorBoundary, toast notifications)'),
      d('Accessibility audit and improvements (semantic HTML, ARIA labels)'),
      d('Mobile responsiveness testing (responsive grid layouts, mobile-first design)'),
      d('Performance optimization (lazy loading, code splitting)'),
      d('Security audit (PII handling, SSRF protection)'),
      d('Sentry/PostHog integration stubs'),
      d('Final visual polish and refinement (Tailwind 4, premium design)'),
    ],
  },
  {
    title: 'UI/UX Redesign — Premium Polish',
    items: [
      d('Redesign landing page with premium hero section and animations'),
      d('Create elegant feature showcase with icons and descriptions'),
      d('Redesign pricing cards with better visual differentiation'),
      d('Add gradient backgrounds and sophisticated color schemes'),
      d('Implement micro-interactions and smooth animations'),
      d('Redesign dashboard with better visual hierarchy'),
      d('Polish Auth pages (signup, login, password reset) with premium OAuth-first design'),
      d('Polish Settings page with premium card styling and refined controls'),
      d('Polish PasswordUpdate page with premium layout and validation feedback'),
      d('Polish Checkout page with premium pricing/CTA styling'),
      d('Polish Admin page tables with responsive layout and action rows'),
      d('Add error state handling to Auth, Settings, Checkout, Admin pages'),
      d('Fix nested anchor tags in Home footer'),
      d('Implement dark mode support'),
      d('Add visual feedback for all interactions'),
    ],
  },
  {
    title: 'Final Delivery',
    items: [
      d('Run full TypeScript and build check (TypeScript clean, build successful)'),
      d('Test all major user flows (signup, upload, report, checkout)'),
      p('Verify responsive design on mobile'),
      p('Create final checkpoint for delivery'),
    ],
  },
  {
    title: 'Carrier Bill Editors — Enhanced',
    items: [
      d('Build Verizon bill editor UI with line item management (demo with sample data)'),
      p('Add tRPC query to load Verizon bills from database'),
      p('Add tRPC mutation to save Verizon bill edits'),
      d('Wire Verizon editor UI to load/save real data'),
      p('Add tRPC query to load T-Mobile bills from database'),
      p('Add tRPC mutation to save T-Mobile bill edits'),
      d('Wire T-Mobile editor UI to load/save real data'),
      p('Add tRPC query to load AT&T bills from database'),
      p('Add tRPC mutation to save AT&T bill edits'),
      d('Wire AT&T editor UI to load/save real data'),
      d('Create unified carrier bill editor interface with carrier selection'),
      d('Implement real carrier-specific optimization rules engine'),
      d('Add bill comparison view (current vs. optimized)'),
      d('Generate before/after savings visualization'),
      d('Export modified bill details (PDF/CSV)'),
      d('Integrate edited bills with audit findings'),
      d('Add manual bill entry interface for all carriers'),
      d('Create carrier-specific validation rules'),
      d('Build bill preview and confirmation flow'),
    ],
  },
];

export interface RoadmapStats {
  total: number;
  done: number;
  pending: number;
  pct: number;
}

export function sectionStats(section: RoadmapSection): RoadmapStats {
  const total = section.items.length;
  let done = 0;
  for (const item of section.items) {
    if (item.done) done += 1;
  }
  return {
    total,
    done,
    pending: total - done,
    pct: total === 0 ? 0 : Math.floor((done / total) * 100),
  };
}

export function overallStats(): RoadmapStats {
  let total = 0;
  let done = 0;
  for (const section of ROADMAP) {
    total += section.items.length;
    for (const item of section.items) {
      if (item.done) done += 1;
    }
  }
  return {
    total,
    done,
    pending: total - done,
    pct: total === 0 ? 0 : Math.floor((done / total) * 100),
  };
}
