-- Anonymous growth counters: how many visits, download clicks and checkout starts per day and source. A count only, never an address, cookie or identifier.
CREATE TABLE site_events (
  day    date   NOT NULL,
  event  text   NOT NULL,
  source text   NOT NULL DEFAULT '',
  n      integer NOT NULL DEFAULT 0,
  PRIMARY KEY (day, event, source)
);
