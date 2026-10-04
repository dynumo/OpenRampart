-- Built-in Event types. Administrators can add custom types at runtime
-- (Settings -> System) without schema changes; built-in types can be archived
-- but not deleted.
INSERT INTO event_types (key, label, description, default_direction, is_builtin, sort_order) VALUES
  ('letter_in', 'Inbound letter', 'A letter or document received by post or by hand.', 'inbound', true, 10),
  ('letter_out', 'Outbound letter', 'A letter you sent.', 'outbound', true, 20),
  ('email_in', 'Inbound email', 'An email you received.', 'inbound', true, 30),
  ('email_out', 'Outbound email', 'An email you sent.', 'outbound', true, 40),
  ('phone_call', 'Phone call', 'A telephone call, made or received.', NULL, true, 50),
  ('voicemail', 'Voicemail', 'A voicemail left for you or by you.', 'inbound', true, 60),
  ('webchat', 'Webchat', 'An online chat with an organisation or person.', NULL, true, 70),
  ('message', 'SMS/message', 'A text message or instant message.', NULL, true, 80),
  ('in_person', 'In-person interaction', 'A meeting, appointment or visit.', NULL, true, 90),
  ('portal', 'Website/portal event', 'Something that happened on a website or online portal, such as an outage or error.', 'internal', true, 100),
  ('submission', 'Submission', 'A form, application or return you submitted.', 'outbound', true, 110),
  ('decision', 'Decision/notice', 'A decision, notice or determination you received.', 'inbound', true, 120),
  ('payment', 'Payment/financial event', 'A payment, refund, charge or balance change.', NULL, true, 130),
  ('observation', 'Observation/discovery', 'Something you noticed or discovered, such as mould or an incorrect balance.', 'internal', true, 140),
  ('third_party', 'Third-party contact', 'Someone was contacted about you, or contacted you about someone else.', NULL, true, 150),
  ('advice', 'Advice received', 'Advice or information you were given.', 'inbound', true, 160),
  ('professional_help', 'Professional help sought', 'You asked a professional or adviser for help.', 'outbound', true, 170),
  ('note', 'Note', 'A note for your own record.', 'internal', true, 180),
  ('other', 'Other', 'Anything else worth recording.', NULL, true, 190);
