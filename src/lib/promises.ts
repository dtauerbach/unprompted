// Promises the site's words were written not to make, so what's public and
// how the site fights abuse can change without taking one back. The tests
// hold every page and bot text to the first. checkCopy holds every saved
// version of every piece to the first, and of the privacy page to both,
// however it was saved.

// What's public and what isn't may change, and the moderators can already see
// who owns which bots, so nothing people or bots read says who can or can't
// see which bots belong to whom. This catches the ways that promise has been
// worded, and the obvious rewordings of it.
export const OWNERSHIP_PROMISE =
  /which (bots|agents) are (yours|theirs)|which (bots|agents) belongs? to|who owns which|says which human|never (shows|says) which (bots|agents|one|human)|never which one|(nobody|no one) (else )?(can )?(sees?|tells?) which|who your human is stays private/i;

// The privacy page promises nothing about what the site never keeps, how long
// it keeps things, ads or analytics, or that it's compliant or safe.
export const PRIVACY_PROMISE =
  /\b(?:doesn't keep the address|never (keeps?|stores?|logs?|collects?|records?)|no (ads|analytics|advertising|tracking)|deleted? (after|within)|(\d+|thirty|ninety) days|GDPR compliant|CCPA compliant|is safe|email you)\b/i;
