import { input, select, confirm } from '@inquirer/prompts';

export interface CreateLeadAnswers {
  first_name: string;
  last_name: string;
  phone: string;
  channel: string;
  location_id: string;
  email?: string;
  treatment_interest?: string;
  first_touch_source?: string;
  first_touch_medium?: string;
  first_touch_campaign?: string;
}

const CHANNEL_CHOICES = [
  { value: 'website_form',          name: 'Website form' },
  { value: 'google_ads',            name: 'Google Ads' },
  { value: 'facebook_ads',          name: 'Facebook / Instagram Ads' },
  { value: 'call_tracking',         name: 'Call tracking' },
  { value: 'referral',              name: 'Referral' },
  { value: 'walk_in',               name: 'Walk-in' },
  { value: 'chat',                  name: 'Chat widget' },
  { value: 'google_business_profile', name: 'Google Business Profile' },
  { value: 'csv_import',            name: 'CSV import' },
];

const required = (v: string) => v.trim() ? true : 'Required';
const empty = (v: string) => v.trim() || undefined;

export async function promptCreateLead(): Promise<CreateLeadAnswers> {
  const first_name = await input({ message: 'First name:', validate: required });
  const last_name  = await input({ message: 'Last name:',  validate: required });
  const phone      = await input({ message: 'Phone:',      validate: required });
  const channel     = await select({ message: 'Channel:', choices: CHANNEL_CHOICES });
  const location_id = await input({ message: 'Location ID (UUID):', validate: required });

  const addOptional = await confirm({ message: 'Add optional fields?', default: false });

  let email: string | undefined;
  let treatment_interest: string | undefined;
  let first_touch_source: string | undefined;
  let first_touch_medium: string | undefined;
  let first_touch_campaign: string | undefined;

  if (addOptional) {
    email               = empty(await input({ message: 'Email:' }));
    treatment_interest  = empty(await input({ message: 'Treatment interest (e.g. braces, invisalign):' }));
    first_touch_source  = empty(await input({ message: 'UTM source:' }));
    first_touch_medium  = empty(await input({ message: 'UTM medium:' }));
    first_touch_campaign = empty(await input({ message: 'UTM campaign:' }));
  }

  return {
    first_name, last_name, phone, channel, location_id,
    email, treatment_interest,
    first_touch_source, first_touch_medium, first_touch_campaign,
  };
}

export interface UpdateLeadAnswers {
  first_name?: string | null;
  last_name?: string | null;
  phone?: string | null;
  email?: string | null;
  treatment_interest?: string | null;
  location_id?: string | null;
}

export async function promptUpdateLead(current: Record<string, unknown>): Promise<UpdateLeadAnswers> {
  const str = (k: string) => (current[k] as string | undefined) ?? '';
  const ans = (v: string, orig: string): string | null | undefined => {
    if (v === orig) return undefined;   // unchanged — omit from PATCH
    if (v.trim() === '') return null;   // explicitly cleared
    return v;                           // changed value
  };

  const fn = await input({ message: 'First name:',        default: str('first_name') });
  const ln = await input({ message: 'Last name:',         default: str('last_name') });
  const ph = await input({ message: 'Phone:',             default: str('phone') });
  const em = await input({ message: 'Email:',             default: str('email') });
  const ti = await input({ message: 'Treatment interest:', default: str('treatment_interest') });
  const lo = await input({ message: 'Location ID:',       default: str('location_id') });

  return {
    first_name:         ans(fn, str('first_name')),
    last_name:          ans(ln, str('last_name')),
    phone:              ans(ph, str('phone')),
    email:              ans(em, str('email')),
    treatment_interest: ans(ti, str('treatment_interest')),
    location_id:        ans(lo, str('location_id')),
  };
}
