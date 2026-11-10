---
name: whatsapp-actions
description: "Use when the user asks to edit, delete or react to a WhatsApp message, or to archive, pin, mute or mark as read or unread a WhatsApp chat, or when such an action fails or its outcome is unclear."
---

# Actions

| Tool                      | Does                                                               | Writes |
| ------------------------- | ------------------------------------------------------------------ | ------ |
| `whatsapp_chat_archive`   | archives a chat, or unarchives it                                  | yes    |
| `whatsapp_chat_mark`      | marks a chat read or unread, optionally with read receipts         | yes    |
| `whatsapp_chat_mute`      | mutes a chat for 8 hours, a week or always, or unmutes it          | yes    |
| `whatsapp_chat_pin`       | pins a chat, or unpins it                                          | yes    |
| `whatsapp_message_delete` | deletes a message the user sent, for everyone                      | yes    |
| `whatsapp_message_edit`   | replaces the text of a message the user sent                       | yes    |
| `whatsapp_message_react`  | reacts to a message with one emoji, or removes the user's reaction | yes    |

The tools are in the `actions` toolset, which is off by default. They work
through the sync service, which must be running (see `whatsapp_account_read`).

Act only when the user asked for this very action on this very message. Never
edit or delete a message to correct, tidy or finish something on your own.

Find the chat and the message first. A chat is a JID, never a name or a
number: take it from `whatsapp_chat_read` (`list`), and take the message's
`id` from the same tool (`view` or `search`). The chat must be a person or a
group the mirror holds, and the message one of that chat, readable and not
deleted; a reaction is not a message to act on. Anything else is refused
before anything leaves.

## Delete

`whatsapp_message_delete` deletes for everyone a message the user sent, of any
kind (text, photo, file, poll, vote) but a call, at most two days after it was
sent: WhatsApp's own limit, past which it is `forbidden`. Another person's
message is `forbidden` too; a group admin's deleting of other people's
messages is not offered. It cannot be undone, and the people in the chat see
that the message was deleted, so ask the user first unless they named exactly
this message. The service pauses syncing for the call, a few seconds, and
`service_running` says whether it syncs again; when it is `false`, tell the
user, because the mirror receives nothing until the service is started.

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

## Chats

`whatsapp_chat_archive`, `whatsapp_chat_pin`, `whatsapp_chat_mute` and
`whatsapp_chat_mark` set one state of a person's or a group's chat the mirror
holds; they need only the `chat`, no message. Only the user's own devices show
the change, and nobody in the chat learns of it, except for read receipts
(below). Archiving also unpins the chat. WhatsApp pins at most
three chats: pinning a fourth is refused until one is unpinned. A mute lasts
`8_hours`, `1_week` or `always`, as the phone offers; `off` unmutes, and a
timed mute's result says when it ends. Each call sets a state, so calling it
again with the same arguments changes nothing more.

### Read state

`whatsapp_chat_mark` marks a chat read (`read: true`) or unread (`read: false`).
By default it tells no one: only the user's own devices show the chat as read,
and marking it read clears the phone's unread mark. `receipts: true`, only with
`read: true`, sends read receipts for up to 100 unread messages instead, and
that does tell their senders that the chat was read (unless the user turned
read receipts off in WhatsApp's privacy settings). In that mode only the
receipts go out and the mirror's unread count is cleared; the phone's unread
mark may stay until the user opens the chat. Set `receipts` only when the user
asks for receipts explicitly, never to be thorough. The result's `receipts`
counts the messages they went for, `senders_told` says whether they could reach
the senders (true cannot be confirmed to the end: WhatsApp may have kept them to
the user's own devices), and `note` says which of these happened. An
`uncertain` receipts call may have sent some already, and calling again may
send them again, which only tells the senders once more.

## Outcomes

A result means WhatsApp accepted the action, not that every device shows it
yet. `errors.record` says when it was accepted but could not be written to the
mirror; it is not repeated.

A failure before anything went out says what to do: the service is not
running (start it), the message is not the user's or too old, or WhatsApp's
queue dropped the request (`upstream_error`, trying again is safe).

`uncertain` means the action may have gone out. Read the chat with
`whatsapp_chat_read` (the mirror may not show it yet), tell the user, and ask
before trying again; never repeat it on your own. The exception is a chat's
state: calling it again with the same arguments is safe, though the user
still hears that the first call's outcome was unclear.

Omit `account` to pick the only paired label; with several, name one.
