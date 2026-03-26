// Parse SIP messages from CUCM SDL trace files

const SIP_INCOMING_RE =
  /SIPTcp - wait_SdlReadRsp: Incoming SIP (?:TCP|UDP) message from ([\d.]+) on port (\d+)/;
const SIP_OUTGOING_RE =
  /SIPTcp - wait_SdlSPISignal: Outgoing SIP (?:TCP|UDP) message to ([\d.]+) on port (\d+)/;
const SDL_LINE_RE =
  /^(\d+\.\d+)\s+\|(\d{2}:\d{2}:\d{2}\.\d+)\s+\|(\w+)\s+\|(.*)$/;
const SIP_REQUEST_RE =
  /^(INVITE|ACK|BYE|CANCEL|REGISTER|OPTIONS|NOTIFY|REFER|UPDATE|SUBSCRIBE|INFO|PRACK|MESSAGE)\s+sip:/;
const SIP_RESPONSE_RE = /^SIP\/2\.0\s+(\d{3})\s+(.*)/;

function parseSdlTrace(content, filterNumbers) {
  const lines = content.split("\n");
  const messages = [];
  let currentMsg = null;
  let sipLines = [];
  let collectingSip = false;
  let baseDate = null;

  // Extract date from file header
  const headerMatch = content.match(/Date:\s*(\d{4}\/\d{2}\/\d{2})/);
  if (headerMatch) {
    baseDate = headerMatch[1].replace(/\//g, "-");
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const sdlMatch = line.match(SDL_LINE_RE);

    if (sdlMatch) {
      // New SDL line — finish any in-progress SIP message
      if (collectingSip && currentMsg) {
        finishMessage(currentMsg, sipLines, messages, filterNumbers);
        currentMsg = null;
        sipLines = [];
        collectingSip = false;
      }

      const [, , timestamp, type, info] = sdlMatch;

      if (type === "AppInfo") {
        // Check for incoming SIP message
        const inMatch = info.match(SIP_INCOMING_RE);
        if (inMatch) {
          currentMsg = {
            timestamp: baseDate ? `${baseDate}T${timestamp}` : timestamp,
            direction: "incoming",
            remoteIp: inMatch[1],
            remotePort: parseInt(inMatch[2], 10),
          };
          collectingSip = true;
          sipLines = [];
          continue;
        }

        // Check for outgoing SIP message
        const outMatch = info.match(SIP_OUTGOING_RE);
        if (outMatch) {
          currentMsg = {
            timestamp: baseDate ? `${baseDate}T${timestamp}` : timestamp,
            direction: "outgoing",
            remoteIp: outMatch[1],
            remotePort: parseInt(outMatch[2], 10),
          };
          collectingSip = true;
          sipLines = [];
          continue;
        }
      }
    } else if (collectingSip) {
      // Non-SDL line while collecting = part of SIP message
      sipLines.push(line);
    }
  }

  // Finish last message
  if (collectingSip && currentMsg) {
    finishMessage(currentMsg, sipLines, messages, filterNumbers);
  }

  return messages;
}

function finishMessage(msg, sipLines, messages, filterNumbers) {
  // Skip empty messages
  const rawSip = sipLines.join("\n").trim();
  if (!rawSip) return;

  // Find the actual SIP start (skip [counter,NET] line)
  const sipStart = sipLines.findIndex(
    (l) => SIP_REQUEST_RE.test(l) || SIP_RESPONSE_RE.test(l),
  );
  if (sipStart === -1) return;

  const sipContent = sipLines.slice(sipStart).join("\n");
  const firstLine = sipLines[sipStart];

  // Parse request or response
  const reqMatch = firstLine.match(SIP_REQUEST_RE);
  const resMatch = firstLine.match(SIP_RESPONSE_RE);

  if (reqMatch) {
    msg.type = "request";
    msg.method = reqMatch[1];
    msg.requestLine = firstLine;
  } else if (resMatch) {
    msg.type = "response";
    msg.statusCode = parseInt(resMatch[1], 10);
    msg.reasonPhrase = resMatch[2];
    msg.statusLine = firstLine;
  } else {
    return; // Not a recognizable SIP message
  }

  // Parse key headers
  msg.callId = extractHeader(sipContent, "Call-ID");
  msg.from = extractHeader(sipContent, "From");
  msg.to = extractHeader(sipContent, "To");
  msg.cseq = extractHeader(sipContent, "CSeq");
  msg.via = extractHeader(sipContent, "Via");
  msg.raw = sipContent;

  // Filter by numbers if provided — search entire raw SIP content
  if (filterNumbers && filterNumbers.length > 0) {
    const matches = filterNumbers.some((num) => sipContent.includes(num));
    if (!matches) return;
  }

  // Extract display info from From/To
  msg.fromNumber = extractSipNumber(msg.from);
  msg.toNumber = extractSipNumber(msg.to);

  // Summary line
  if (msg.type === "request") {
    msg.summary = msg.method;
  } else {
    msg.summary = `${msg.statusCode} ${msg.reasonPhrase}`;
  }

  messages.push(msg);
}

function extractHeader(sip, name) {
  const re = new RegExp(`^${name}:\\s*(.+)`, "mi");
  const match = sip.match(re);
  return match ? match[1].trim() : null;
}

function extractSipNumber(headerValue) {
  if (!headerValue) return null;
  // Match sip:NUMBER@ or sip:NUMBER>
  const match = headerValue.match(/sip:([^@>]+)@/);
  return match ? match[1] : null;
}

module.exports = { parseSdlTrace };
