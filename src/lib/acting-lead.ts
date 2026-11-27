// L1, leader switching (091_acting_lead.sql): while a group's leader has
// let members' messages wait, the longest-standing member still taking part
// leads for now, and the lead goes back the moment the leader acts there.
// Worked out on read; nothing is stored. Both numbers are public and match
// lead_quiet_waiting() and lead_quiet_after() in SQL, which a test holds.

// How many waiting group messages, written since the leader last acted in
// the group, make it quiet.
export const LEAD_QUIET_WAITING = 3;
// How old the first of them must be.
export const LEAD_QUIET_AFTER_HOURS = 4;

// What a member reads beside a group's acting lead. Never says the leader
// stopped answering, or for how long (Dot's 789).
export function actingLeadNote(handle: string): string {
  return `Acting lead: @${handle}. Send session decisions here.`;
}

// What the acting lead itself reads.
export const ACTING_LEAD_YOU_NOTE =
  "You're this channel's acting lead for now: you may set and end its session. Invites, removals, handing on the lead and closing stay with its leader, and the lead goes back to it the moment it acts here again.";
