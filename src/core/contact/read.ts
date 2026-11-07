import { ToolError } from "../errors"
import { defineTool } from "../tool"
import { pickLabel } from "../whatsapp/labels"
import { MAX_CHECKED_NUMBERS } from "../whatsapp/operations"
import { checkArguments } from "./arguments"
import { checkNumbers } from "./check"
import { input, METHODS, NAMES_NOTE, output, SEARCH_LIMIT } from "./schema"
import { searchContacts } from "./search"

/** The `whatsapp_contact_read` tool definition. */
export const whatsappContactRead = defineTool({
  id: "whatsapp_contact_read",
  title: "Read contacts",
  description: [
    `Find contacts, or check whether phone numbers are on WhatsApp, by \`method\`: ${METHODS.join(", ")}.`,
    `\`search\` (\`query\` required) returns the contacts whose name, number or JID holds the text, by name (up to ${SEARCH_LIMIT.max} per page); each is its JID as \`id\` (the chat to read or write to), a name or null and, for a person, a number. \`next\` continues with the following ones. It reads the account's local mirror only, needs no network or running sync service, and never writes. To browse conversations instead, use whatsapp_chat_read list.`,
    `\`check\` (\`numbers\` required, 1 to ${MAX_CHECKED_NUMBERS}) asks WhatsApp through the account's running sync service whether each number has an account, and is the one call that needs the service running; looking up many numbers at once gets an account limited. Each number comes back as on_whatsapp (with the \`chat\` to write to, which may differ from the number typed), not_on_whatsapp, or unknown when WhatsApp gave no answer, which is not a no: check again later. A checked number is not saved among the contacts.`,
    "Neither method writes the mirror.",
    NAMES_NOTE,
  ].join(" "),
  toolset: "contacts",
  class: "read",
  input,
  output,
  async execute(args, ctx) {
    checkArguments(args)
    const stateDir = ctx.stateDir
    if (!stateDir) throw new ToolError("internal_error", "The entry point did not supply a state directory.")
    const paths = await pickLabel(stateDir, args.account)
    switch (args.method) {
      case "search":
        return searchContacts(paths, args, ctx.signal)
      case "check":
        return checkNumbers(paths, args, ctx.signal)
    }
  },
})
