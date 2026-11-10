---
name: whatsapp-actions
description: "Use when the user asks to edit or react to a WhatsApp message, or when such an action fails or its outcome is unclear."
---

# Actions

| Tool                     | Does                                                               | Writes |
| ------------------------ | ------------------------------------------------------------------ | ------ |
| `whatsapp_message_edit`  | replaces the text of a message the user sent                       | yes    |
| `whatsapp_message_react` | reacts to a message with one emoji, or removes the user's reaction | yes    |

The tools are in the `actions` toolset, which is off by default. They work
through the sync service, which must be running (see `whatsapp_account_read`).

Act only when the user asked for this very action on this very message. Never
edit a message to correct, tidy or finish something on your own.

Find the chat and the message first. A chat is a JID, never a name or a
number: take it from `whatsapp_chat_read` (`list`), and take the message's
`id` from the same tool (`view` or `search`). The chat must be a person or a
group the mirror holds, and the message one of that chat, readable and not
deleted; a reaction is not a message to act on. Anything else is refused
before anything leaves.

## Edit

`whatsapp_message_edit` replaces the text of a text message the user sent, at
most 15 minutes after it was sent: WhatsApp's own limit, past which it is
`forbidden`. Another person's message is `forbidden` too. A photo, a file, a
poll or a call cannot be edited, and a new text equal to the current one is
refused. The new `text` goes out exactly as given, surrounding blank space
trimmed, at most 4,000 characters. The people in the chat see the message
marked as edited, and the earlier text is gone from it.

## React

`whatsapp_message_react` reacts to any readable message of a person's or a
group's chat, the user's own or someone else's, with no time limit. `emoji` is
exactly one emoji; a new reaction replaces the user's earlier one on that
message. `remove: true` takes the user's reaction off instead; give `emoji` or
`remove`, never both. A call or a vote on a poll cannot be reacted to, but a
poll can.

## Outcomes

A result means WhatsApp accepted the action, not that every device shows it
yet. `errors.record` says when it was accepted but could not be written to the
mirror; it is not repeated.

A failure before anything went out says what to do: the service is not
running (start it), the message is not the user's or too old, or WhatsApp's
queue dropped the request (`upstream_error`, trying again is safe).

`uncertain` means the edit or reaction may have gone out. Read the chat with
`whatsapp_chat_read` (the mirror may not show it yet), tell the user, and ask
before trying again; never repeat it on your own.

Omit `account` to pick the only paired label; with several, name one.
