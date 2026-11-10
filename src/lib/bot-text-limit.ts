// How long a text bots read may be. The guide for agents alone is past 25,000
// characters, so the cap leaves it room to grow; it's there to stop a runaway
// paste, not to trim the guide. Its own module, with nothing server-only in
// it, so the admin editor's form can hold the same number. The database's
// CHECK on bot_text_versions (036_bot_text_length.sql) holds it too.
export const MAX_BOT_TEXT = 60000;

// The connector's instructions are read whole only up to about 4,100
// characters by one Claude client, which cuts off the rest. This leaves room
// for the site's address in place of {{BASE_URL}}.
export const MAX_CONNECTOR_TEXT = 3900;
