// Demo data for a container demo: a small broadcast control room's crew
// and talk groups, so a fresh `podman-compose up` has something real to
// log into. Opt-in only (SEED_DEMO=true -see config.ts), never on by default.
//
// Additive and idempotent: an extension or dial code that already exists
// is left exactly as it is, and buttons are only added for users this run
// created -so re-running on every startup never duplicates anything or
// touches real data that happens to share a name.
import config from '../config';
import * as groups from './groupService';
import * as dirUsers from './directoryUserService';

const ACTOR = 'demo-seed';

interface DemoGroup { dial_code: string; name: string; description: string; ptt_default: boolean }
interface DemoUser { extension: string; name: string; icm: string[]; groups: string[] }

// ptt_default: true = joins muted (hold-to-talk); false = open mic.
const GROUPS: DemoGroup[] = [
  { dial_code: 'production', name: 'Production', description: 'Director, producer and gallery -open talkback', ptt_default: false },
  { dial_code: 'cameras', name: 'Cameras', description: 'Director to camera ops -PTT', ptt_default: true },
  { dial_code: 'engineering', name: 'Engineering', description: 'Vision, audio and graphics -open talkback', ptt_default: false },
  { dial_code: 'floor', name: 'Studio Floor', description: 'Gallery to floor manager -PTT', ptt_default: true },
  { dial_code: 'allcall', name: 'All Call', description: 'Whole crew -PTT, for announcements', ptt_default: true },
];

const USERS: DemoUser[] = [
  { extension: '2001', name: 'Director', icm: ['2002', '2003', '2004', '2007'], groups: ['production', 'cameras', 'floor', 'allcall'] },
  { extension: '2002', name: 'Producer', icm: ['2001', '2007', '2008'], groups: ['production', 'floor', 'allcall'] },
  { extension: '2003', name: 'Vision Mixer', icm: ['2001', '2004', '2008'], groups: ['production', 'engineering', 'allcall'] },
  { extension: '2004', name: 'Audio Engineer', icm: ['2001', '2003', '2007'], groups: ['engineering', 'floor', 'allcall'] },
  { extension: '2005', name: 'Camera 1', icm: ['2001', '2006'], groups: ['cameras', 'allcall'] },
  { extension: '2006', name: 'Camera 2', icm: ['2001', '2005'], groups: ['cameras', 'allcall'] },
  { extension: '2007', name: 'Floor Manager', icm: ['2001', '2002', '2004'], groups: ['floor', 'production', 'allcall'] },
  { extension: '2008', name: 'Graphics', icm: ['2002', '2003'], groups: ['engineering', 'allcall'] },
];

export async function seedDemoData(): Promise<void> {
  if (!config.seedDemo) return;

  const groupIds = new Map<string, string>();
  let groupsCreated = 0;
  for (const g of GROUPS) {
    const existing = await groups.getGroupByDialCode(g.dial_code);
    if (existing) { groupIds.set(g.dial_code, existing.id); continue; }
    const created = await groups.createGroup(ACTOR, g);
    groupIds.set(g.dial_code, created.id);
    groupsCreated++;
  }

  const existingExts = new Set((await dirUsers.listDirectoryUsers()).map((u) => u.extension));
  let usersCreated = 0;
  for (const u of USERS) {
    if (existingExts.has(u.extension)) continue;
    const created = await dirUsers.createDirectoryUser(ACTOR, {
      name: u.name, extension: u.extension, password: config.demoPassword,
    });
    usersCreated++;
    let order = 0;
    for (const ext of u.icm) {
      await dirUsers.addButton(created.id, { button_type: 'direct', target_extension: ext, sort_order: order++ });
    }
    for (const code of u.groups) {
      const id = groupIds.get(code);
      if (id) await dirUsers.addButton(created.id, { button_type: 'group', target_group_id: id, sort_order: order++ });
    }
  }

  console.log(`[demo] SEED_DEMO on: ${groupsCreated} group(s), ${usersCreated} user(s) created ` +
    `(extensions ${USERS[0].extension}-${USERS[USERS.length - 1].extension}, password from DEMO_PASSWORD)`);
}
