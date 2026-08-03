export const beachEventEdgeCaseCalendar = `BEGIN:VCALENDAR\r
VERSION:2.0\r
PRODID:-//Official Test Calendar//EN\r
METHOD:PUBLISH\r
BEGIN:VEVENT\r
UID:registration-url\r
SUMMARY:Pier &amp; Beach Cleanup\r
LOCATION:<p>Gulf State Park Pier</p><p>20800 E Beach Blvd\\, Gulf Shores\\, AL 36542</p>\r
DESCRIPTION:Official details https://city.example.gov/events/pier-cleanup\r
DTSTART;TZID=America/New_York:20260801T090000\r
DTEND;TZID=America/New_York:20260801T103000\r
URL:https://tickets.example.gov/register/pier-cleanup?session=morning\r
SEQUENCE:4\r
LAST-MODIFIED:20260720T150000Z\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:recurring-program\r
RECURRENCE-ID;TZID=America/Chicago:20260802T090000\r
SUMMARY:Family Beach Program\r
LOCATION:Gulf Shores Public Beach\\n101 E Beach Blvd\\, Gulf Shores\\, AL 36542\r
DTSTART;TZID=America/Chicago:20260802T090000\r
DTEND;TZID=America/Chicago:20260802T100000\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:recurring-program\r
RECURRENCE-ID;TZID=America/Chicago:20260809T090000\r
SUMMARY:Family Beach Program\r
LOCATION:Gulf Shores Public Beach\\n101 E Beach Blvd\\, Gulf Shores\\, AL 36542\r
DTSTART;TZID=America/Chicago:20260809T090000\r
DTEND;TZID=America/Chicago:20260809T100000\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:all-day-dst\r
SUMMARY:All-Day Beach Festival\r
LOCATION:Gulf Shores Public Beach\r
DTSTART;VALUE=DATE:20260308\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:multi-day\r
SUMMARY:Multi-Day Beach Sports\r
LOCATION:Gulf Shores Public Beach\r
DTSTART;VALUE=DATE:20260308\r
DTEND;VALUE=DATE:20260310\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:cancelled-event\r
SUMMARY:Beach Wildlife Walk\r
LOCATION:Cotton Bayou Public Beach\r
DTSTART:20260803T140000Z\r
DTEND:20260803T150000Z\r
STATUS:CANCELLED\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:postponed-event\r
SUMMARY:POSTPONED: Pier Fishing Clinic\r
LOCATION:Gulf State Park Pier\r
DTSTART:20260804T140000Z\r
DTEND:20260804T150000Z\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:no-end\r
SUMMARY:Sunset Beach Talk\r
LOCATION:Gulf Shores Public Beach\r
DTSTART;TZID=America/Chicago:20260805T180000\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:no-end\r
SUMMARY:Sunset Beach Talk\r
LOCATION:Gulf Shores Public Beach\r
DTSTART;TZID=America/Chicago:20260805T180000\r
END:VEVENT\r
END:VCALENDAR`;
