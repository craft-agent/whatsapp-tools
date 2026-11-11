---
name: whatsapp-sends
description: "Use when sending a WhatsApp text to a person or a group, replying to a message, or when a send fails or its outcome is unclear."
metadata:
  toolset: sends
---

# Sends

| Tool                    | Does                                                   | Writes |
| ----------------------- | ------------------------------------------------------ | ------ |
| `whatsapp_message_send` | sends one text to a chat, optionally quoting a message | yes    |

Find the chat first: a chat is a JID, never a name or a number. For an
existing chat, take its `id` from `whatsapp_chat_read` (`list`). For someone the
mirror does not hold yet, check their number with `whatsapp_contact_read`
(`check`) and use the `chat` it gives; a hidden-number (`…@lid`) contact or a
group the mirror does not hold is `not_found`. A number that is not on WhatsApp
is `not_found` too, and a number WhatsApp did not answer for is an error:
nothing is sent either way. The sync service must be running (see
`whatsapp_account_read`).

Send `text` exactly as the user wants it: surrounding blank space is trimmed,
nothing else changes, and it is at most 4,000 characters. Never rephrase,
shorten or add to it without saying so. Split a longer text into several sends
only when the user agrees. No link preview is made, so a link goes out as plain
text.

Sends go to people and groups only. A channel, a broadcast list, the status
feed and the user's own chat are refused.

To reply, pass `reply_to`, the id of a message of that chat as
`whatsapp_chat_read` gives it. A message the mirror does not hold, or one that
was deleted, cannot be quoted. Someone new has no messages to quote.

A result means WhatsApp accepted the message, not that it was delivered or
read. The send lowers the chat's unread count in the mirror, as writing in it
on the phone does, and sends no read receipt. `errors.record` says when the
message was sent but could not be written to the mirror; it is not sent again.

A failure before anything went out says what to do: the service is not running
(start it), the number is not on WhatsApp, or WhatsApp's queue dropped the
request (`upstream_error`, sending again is safe).

`uncertain` means the message may have gone out. Read the chat with
`whatsapp_chat_read` (the mirror may not show it yet), tell the user, and ask
before sending it again; never send it again on your own. Another person gets
a second copy of a resend that guessed wrong.

Omit `account` to pick the only paired label; with several, name one.
