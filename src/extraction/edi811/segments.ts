/**
 * Constants for the X12 811 qualifiers we actually care about.
 *
 * Wireless 811 implementation guides reuse the same handful of qualifier
 * codes across carriers. Centralising them here keeps the mapper readable
 * and gives the carrier-specific overrides a single import point.
 */

/** N1 entity identifier codes. */
export const N1_REMIT_TO = 'RE';
export const N1_BILL_TO = 'BT';

/** REF reference identification qualifiers. */
export const REF_ACCOUNT_NUMBER = '9V'; // Carrier's account number for the customer
export const REF_BILLING_ACCOUNT = 'BAA'; // Some 4010 dialects use BAA
export const REF_MOBILE_NUMBER = 'MN'; // MTN / MDN
export const REF_USER_LABEL = 'EM'; // Subscriber name / employee handle (carrier-defined)

/** DTM date/time qualifiers. */
export const DTM_INVOICE_DATE = '003';
export const DTM_SERVICE_PERIOD_START = '150';
export const DTM_SERVICE_PERIOD_END = '151';
/** Alternative service-period qualifiers seen in 4010 → 5010 dialects. */
export const DTM_SERVICE_PERIOD_START_ALT = '232';
export const DTM_SERVICE_PERIOD_END_ALT = '233';

/** HL hierarchy level codes. */
export const HL_ACCOUNT = 'A';
export const HL_SUBSCRIBER = 'B';

/** SAC indicator codes (SAC01). */
export const SAC_ALLOWANCE = 'A';
export const SAC_CHARGE = 'C';

/** SAC service-id codes (SAC02) we recognise. Carrier-specific ones live in the carrier modules. */
export const SAC_PLAN = 'D240'; // Monthly service / plan
export const SAC_DEVICE_INSTALLMENT = 'D830'; // Equipment installment / DPP
export const SAC_PROMO_CREDIT = 'F050'; // Promotional credit
export const SAC_LOYALTY_CREDIT = 'F060'; // Loyalty / retention credit

/** QTY qualifiers for usage. */
export const QTY_DATA_GB = 'DG';
export const QTY_VOICE_MIN = 'VM';
export const QTY_SMS_COUNT = 'SC';

/** PID type for device description. */
export const PID_FREE_FORM = 'F';

/**
 * IT1 product-id qualifier (IT106) values that mean "this IT1 line is a plan".
 * Different carriers use 'VP' (vendor part), 'EN' (EAN), or 'ZZ' (mutually
 * defined) — accept any.
 */
export const IT1_PLAN_QUALIFIERS = new Set(['VP', 'EN', 'ZZ', 'MG']);

/** TXI tax type codes (TXI01). */
export const TXI_STATE = 'ST';
export const TXI_LOCAL = 'LO';
export const TXI_FEDERAL = 'FD';
export const TXI_USF = 'F1';
