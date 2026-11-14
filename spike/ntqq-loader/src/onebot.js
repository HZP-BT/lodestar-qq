/*
 * Minimal OneBot v11 WebSocket server for the NTQQ self-loader spike.
 *
 * Scope:
 *   - broadcast message events (private/group) with text/image/record segments
 *   - handle get_login_info / get_status / get_version_info
 *   - handle send_private_msg / send_group_msg / send_msg for text only
 *
 * It intentionally does not implement the full OneBot surface, media upload,
 * notices, requests, or message recall. Local-only; no credentials are read.
 */
const fs = require('fs');
const pathModule = require('path');
const crypto = require('crypto');
const { imageSize } = require('./image-size');
const { WebSocketServer } = require('./ws');

function safeJson(value) {
  try {
    return JSON.parse(
      JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item)),
    );
  } catch {
    return null;
  }
}

function createLogger(logPath) {
  return (entry) => {
    try {
      fs.appendFileSync(
        logPath,
        JSON.stringify({ time: new Date().toISOString(), ...entry }) + '\n',
      );
    } catch {}
  };
}

function mapElement(element) {
  if (element.atElement) {
    const at = element.atElement;
    const atType = Number(at.atType) || 0;
    const segments = [];
    if (atType === 1) {
      segments.push({ type: 'at', data: { qq: 'all' } });
    } else {
      const target = at.atUid || at.atNtUid || at.uid || '';
      if (target && String(target) !== '0') {
        segments.push({ type: 'at', data: { qq: String(target) } });
      }
    }
    if (at.text) {
      segments.push({ type: 'text', data: { text: at.text } });
    }
    return segments;
  }
  if (element.textElement) {
    const text = element.textElement;
    const segments = [];
    const atType = Number(text.atType) || 0;
    if (atType === 1) {
      segments.push({ type: 'at', data: { qq: 'all' } });
    } else if (atType === 2 && text.atUid && text.atUid !== '0') {
      segments.push({ type: 'at', data: { qq: String(text.atUid) } });
    } else if (atType === 2 && text.atNtUid && text.atNtUid !== '0') {
      segments.push({ type: 'at', data: { qq: String(text.atNtUid) } });
    }
    if (text.content) {
      segments.push({ type: 'text', data: { text: text.content } });
    }
    return segments;
  }
  if (element.picElement) {
    const pic = element.picElement;
    const file = pic.sourcePath || pic.fileUuid || '';
    const originUrl = typeof pic.originImageUrl === 'string' ? pic.originImageUrl : '';
    // 9.9.37 returns a relative /download?... path. AstrBot prefers `url` over
    // `file`, so only expose `url` when it is a complete HTTP(S) address and
    // otherwise let it resolve the local sourcePath.
    const url = /^https?:\/\//i.test(originUrl) ? originUrl : '';
    return [
      {
        type: 'image',
        data: {
          file,
          ...(url ? { url } : {}),
        },
      },
    ];
  }
  if (element.pttElement) {
    return [
      {
        type: 'record',
        data: { file: element.pttElement.filePath || '' },
      },
    ];
  }
  if (element.faceElement) {
    return [
      {
        type: 'face',
        data: { id: String(element.faceElement.faceIndex ?? '') },
      },
    ];
  }
  if (element.replyElement) {
    return [
      {
        type: 'reply',
        data: { id: String(element.replyElement.replyMsgSeq ?? '') },
      },
    ];
  }
  return [];
}

function makeTextElement(text) {
  return {
    elementType: 1,
    elementId: '0',
    textElement: {
      content: text,
      atType: 0,
      atUid: '0',
      atTinyId: '0',
      atNtUid: '',
    },
  };
}

function startOneBot({ service, config, selfId, nickname }) {
  const log = createLogger(`D:\\qq-loader\\onebot-${process.pid}.jsonl`);
  const host = config.host || '127.0.0.1';
  const port = Number(config.port || 3001);
  const token = config.accessToken || '';
  const clients = new Set();
  const peerByUser = new Map();
  const peerByGroup = new Map();
  const mediaByMd5 = new Map();
  let latestPic = null;
  let latestPtt = null;
  // Core persists sourceEventId-based dedup keys across restarts. A per-process
  // counter starting at -1 would collide with old messages after QQ restarts
  // and silently drop new events, so seed each process with a distinct base.
  const messageIdBase = -(Math.floor(Date.now() / 1000) * 1000 + (process.pid % 1000));
  let nextMessageId = messageIdBase;
  let heartbeatTimer = null;

  function send(ws, payload) {
    try {
      ws.send(JSON.stringify(payload));
    } catch {}
  }

  function broadcast(payload) {
    const text = JSON.stringify(payload);
    for (const ws of clients) {
      try {
        ws.send(text);
      } catch {}
    }
  }

  function actionResponse(ws, echo, status, retcode, data, message) {
    send(ws, {
      status,
      retcode,
      data: data ?? null,
      echo: echo ?? null,
      ...(message ? { message } : {}),
    });
  }

  function ensureMedia(message, element) {
    try {
      const pic = element.picElement;
      const ptt = element.pttElement;
      const target = pic?.sourcePath || ptt?.filePath;
      if (!target) return;
      let exists = false;
      try {
        exists = fs.statSync(target).isFile();
      } catch {}
      if (exists) return;
      const result = service.downloadRichMedia({
        msgId: message.msgId,
        elemId: element.elementId,
        elementId: element.elementId,
        chatType: message.chatType,
        peerUid: message.peerUid,
        downloadType: 2,
        thumbSize: 0,
      });
      if (result && typeof result.then === 'function') {
        result.catch((error) => log({ kind: 'media_download_error', error: String(error) }));
      }
      log({ kind: 'media_download_request', msgId: message.msgId });
    } catch (error) {
      log({ kind: 'media_download_throw', error: String(error) });
    }
  }

  function cacheMedia(element) {
    if (element.picElement?.md5HexStr) {
      const cached = { type: 'pic', element };
      mediaByMd5.set(element.picElement.md5HexStr, cached);
      latestPic = cached;
      log({
        kind: 'media_cached',
        mediaType: 'pic',
        md5: element.picElement.md5HexStr,
        hasSource: Boolean(element.picElement.sourcePath),
      });
    }
    if (element.pttElement?.md5HexStr) {
      const cached = { type: 'ptt', element };
      mediaByMd5.set(element.pttElement.md5HexStr, cached);
      latestPtt = cached;
      log({
        kind: 'media_cached',
        mediaType: 'ptt',
        md5: element.pttElement.md5HexStr,
        hasFile: Boolean(element.pttElement.filePath),
      });
    }
  }

  function resolveMedia(data, type) {
    const file = data?.file;
    if (!file || file === 'latest') {
      return type === 'pic' ? latestPic : latestPtt;
    }
    if (mediaByMd5.has(file)) {
      return mediaByMd5.get(file);
    }
    if (file.includes('\\') || file.includes('/')) {
      try {
        const md5 = crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex');
        return mediaByMd5.get(md5) ?? null;
      } catch {
        return null;
      }
    }
    return null;
  }

  function fileMd5(filePath) {
    return crypto.createHash('md5').update(fs.readFileSync(filePath)).digest('hex');
  }

  function picTypeFor(filePath) {
    const ext = pathModule.extname(filePath).toLowerCase();
    if (ext === '.png') return 1001;
    if (ext === '.gif') return 2000;
    if (ext === '.bmp') return 1005;
    if (ext === '.webp') return 1002;
    return 1000;
  }

  function uploadPic(filePath) {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size === 0) {
      throw new Error('image is missing or empty');
    }
    const md5 = fileMd5(filePath);
    const fileName = pathModule.basename(filePath);
    const dimensions = imageSize(fs.readFileSync(filePath));
    const mediaPath = service.getRichMediaFilePathForGuild({
      md5HexStr: md5,
      fileName,
      elementType: 2,
      elementSubType: 0,
      thumbSize: 0,
      needCreate: true,
      downloadType: 1,
      file_uuid: '',
    });
    if (!mediaPath) {
      throw new Error('getRichMediaFilePathForGuild returned no path');
    }
    fs.copyFileSync(filePath, mediaPath);
    log({
      kind: 'media_upload',
      mediaType: 'pic',
      size: stat.size,
      md5,
      width: dimensions.width,
      height: dimensions.height,
    });
    return {
      elementType: 2,
      elementId: '',
      picElement: {
        md5HexStr: md5,
        fileSize: String(stat.size),
        picWidth: dimensions.width,
        picHeight: dimensions.height,
        fileName,
        sourcePath: mediaPath,
        filePath: mediaPath,
        original: true,
        picType: picTypeFor(filePath),
        picSubType: 0,
        fileUuid: '',
        fileSubId: '',
        thumbFileSize: 0,
        summary: '',
      },
    };
  }

  function uploadPtt(filePath, duration) {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size === 0) {
      throw new Error('voice is missing or empty');
    }
    const md5 = fileMd5(filePath);
    const fileName = pathModule.basename(filePath);
    const mediaPath = service.getRichMediaFilePathForGuild({
      md5HexStr: md5,
      fileName,
      elementType: 4,
      elementSubType: 0,
      thumbSize: 0,
      needCreate: true,
      downloadType: 1,
      file_uuid: '',
    });
    if (!mediaPath) {
      throw new Error('getRichMediaFilePathForGuild returned no path');
    }
    fs.copyFileSync(filePath, mediaPath);
    log({
      kind: 'media_upload',
      mediaType: 'ptt',
      size: stat.size,
      md5,
      duration,
    });
    return {
      elementType: 4,
      elementId: '',
      pttElement: {
        fileName,
        filePath: mediaPath,
        md5HexStr: md5,
        fileSize: String(stat.size),
        duration: Number(duration) || 1,
        formatType: 1,
        voiceType: 1,
        voiceChangeType: 0,
        canConvert2Text: true,
        waveAmplitudes: [0, 18, 9, 23, 16, 17, 16, 15, 44, 17, 24, 20, 14, 15, 17],
        fileSubId: '',
        playState: 1,
        autoConvertText: 0,
        storeID: 0,
        otherBusinessInfo: { aiVoiceType: 0 },
      },
    };
  }

  function buildSendElements(message) {
    if (typeof message === 'string') {
      return message ? [makeTextElement(message)] : [];
    }
    if (!Array.isArray(message)) {
      throw new Error('message must be a string or an array of segments');
    }

    const elements = [];
    for (const segment of message) {
      if (segment?.type === 'text') {
        const text = segment?.data?.text ?? '';
        if (text) elements.push(makeTextElement(text));
      } else if (segment?.type === 'image') {
        const file = segment.data?.file;
        if (file && file !== 'latest' && fs.existsSync(file)) {
          elements.push(uploadPic(file));
        } else {
          const cached = resolveMedia(segment.data, 'pic');
          if (!cached) {
            throw new Error('image not cached; provide a local file path or receive it once first');
          }
          elements.push({
            elementType: 2,
            elementId: '',
            picElement: { ...cached.element.picElement },
          });
        }
      } else if (segment?.type === 'record') {
        const file = segment.data?.file;
        if (file && file !== 'latest' && fs.existsSync(file)) {
          elements.push(uploadPtt(file, segment.data?.duration));
        } else {
          const cached = resolveMedia(segment.data, 'ptt');
          if (!cached) {
            throw new Error(
              'record not cached; provide a local file path or receive it once first',
            );
          }
          elements.push({
            elementType: 4,
            elementId: '',
            pttElement: { ...cached.element.pttElement },
          });
        }
      } else {
        throw new Error(`unsupported send segment: ${segment?.type}`);
      }
    }
    return elements;
  }

  function makeEvent(message) {
    const isGroup = message.chatType === 2;
    const userId = Number(message.senderUin);
    const groupId = isGroup ? Number(message.peerUid) : null;
    if (isGroup) {
      peerByGroup.set(groupId, {
        chatType: 2,
        peerUid: String(message.peerUid),
      });
    } else {
      peerByUser.set(userId, {
        chatType: 1,
        peerUid: String(message.peerUid),
      });
    }

    const segments = [];
    for (const element of message.elements ?? []) {
      ensureMedia(message, element);
      cacheMedia(element);
      segments.push(...mapElement(element));
    }
    const rawMessage = segments
      .filter((segment) => segment.type === 'text')
      .map((segment) => segment.data.text)
      .join('');

    return {
      post_type: 'message',
      message_type: isGroup ? 'group' : 'private',
      sub_type: isGroup ? 'normal' : 'friend',
      time: Number(message.msgTime) || Math.floor(Date.now() / 1000),
      self_id: selfId,
      message_id: nextMessageId--,
      message_seq: Number(message.msgSeq) || 0,
      user_id: userId,
      group_id: isGroup ? groupId : undefined,
      message: segments,
      raw_message: rawMessage,
      font: 0,
      sender: {
        user_id: userId,
        nickname: message.sendNickName || message.sendMemberName || '',
        card: message.sendMemberName || '',
      },
    };
  }

  function handleKernelMessages(messages) {
    for (const message of messages ?? []) {
      try {
        const event = makeEvent(message);
        log({
          kind: 'onebot_event',
          messageType: event.message_type,
          messageId: event.message_id,
          segmentTypes: event.message.map((segment) => segment.type),
          elements: (message.elements ?? []).map((element) => ({
            type: element.elementType,
            keys: Object.keys(element),
            atType: element.textElement?.atType ?? element.atElement?.atType ?? null,
            hasAtUid: Boolean(element.textElement?.atUid || element.atElement?.atUid),
            hasAtNtUid: Boolean(element.textElement?.atNtUid || element.atElement?.atNtUid),
          })),
        });
        broadcast(event);
      } catch (error) {
        log({
          kind: 'map_error',
          error: error && error.stack ? error.stack : String(error),
        });
      }
    }
  }

  async function sendElements(peer, elements) {
    const result = await service.sendMsg('0', peer, elements, new Map());
    log({
      kind: 'send_result',
      chatType: peer.chatType,
      elementTypes: elements.map((element) => element.elementType),
      result: safeJson(result),
    });
    return result;
  }

  async function handleSend(ws, action, params, echo) {
    let peer = null;
    if (action === 'send_private_msg') {
      const userId = Number(params.user_id);
      peer = peerByUser.get(userId) ?? null;
    } else if (action === 'send_group_msg') {
      const groupId = Number(params.group_id);
      peer = peerByGroup.get(groupId) ?? {
        chatType: 2,
        peerUid: String(params.group_id),
      };
    } else {
      if (params.message_type === 'group' || params.group_id != null) {
        const groupId = Number(params.group_id);
        peer = peerByGroup.get(groupId) ?? {
          chatType: 2,
          peerUid: String(params.group_id),
        };
      } else {
        const userId = Number(params.user_id);
        peer = peerByUser.get(userId) ?? null;
      }
    }

    if (!peer) {
      actionResponse(
        ws,
        echo,
        'failed',
        100,
        null,
        'unknown private peer; wait for an incoming message from this user',
      );
      return;
    }

    let elements;
    try {
      elements = buildSendElements(params.message);
    } catch (error) {
      actionResponse(ws, echo, 'failed', 100, null, String(error));
      return;
    }
    if (!elements.length) {
      actionResponse(
        ws,
        echo,
        'failed',
        100,
        null,
        'empty message; minimal adapter supports text and cached image/record',
      );
      return;
    }

    try {
      const result = await sendElements(peer, elements);
      const ok = !result || result.result === 0 || result.result === undefined;
      actionResponse(ws, echo, ok ? 'ok' : 'failed', ok ? 0 : 1500, {
        message_id: nextMessageId--,
      });
    } catch (error) {
      log({ kind: 'send_error', error: String(error) });
      actionResponse(ws, echo, 'failed', 1500, null, String(error));
    }
  }

  const listener = new Proxy(
    {},
    {
      get(_target, property) {
        if (typeof property === 'symbol' || property === 'then') {
          return undefined;
        }
        if (property === 'onRecvMsg') {
          return (messages) => handleKernelMessages(messages);
        }
        return () => {};
      },
    },
  );

  service.addKernelMsgListener(listener);

  let wss = null;
  try {
    wss = new WebSocketServer({ host, port });
  } catch (error) {
    log({ kind: 'ws_error', error: String(error) });
  }

  if (wss) {
    wss.on('error', (error) => {
      log({ kind: 'ws_error', error: String(error) });
    });
    wss.on('connection', (ws, request) => {
      const header = request.headers.authorization || '';
      const url = new URL(request.url, `http://${host}`);
      const provided =
        header.replace(/^Bearer\s+/i, '').replace(/^Token\s+/i, '') ||
        url.searchParams.get('access_token') ||
        '';
      if (token && provided !== token) {
        ws.close(4001, 'unauthorized');
        return;
      }
      clients.add(ws);
      send(ws, {
        post_type: 'meta_event',
        meta_event_type: 'lifecycle',
        sub_type: 'connect',
        time: Math.floor(Date.now() / 1000),
        self_id: selfId,
      });
      const timer = setInterval(() => {
        send(ws, {
          post_type: 'meta_event',
          meta_event_type: 'heartbeat',
          time: Math.floor(Date.now() / 1000),
          self_id: selfId,
          interval: 30000,
          status: { online: true, good: true },
        });
      }, 30000);
      ws.on('close', () => {
        clearInterval(timer);
        clients.delete(ws);
      });
      ws.on('error', () => {
        clearInterval(timer);
        clients.delete(ws);
      });
      ws.on('message', async (raw) => {
        let request;
        try {
          request = JSON.parse(String(raw));
        } catch {
          actionResponse(ws, null, 'failed', 100, null, 'invalid JSON');
          return;
        }
        const { action, params = {}, echo = null } = request ?? {};
        log({ kind: 'onebot_action', action });
        try {
          if (action === 'get_login_info') {
            actionResponse(ws, echo, 'ok', 0, {
              user_id: selfId,
              nickname,
            });
          } else if (action === 'get_status') {
            actionResponse(ws, echo, 'ok', 0, {
              online: true,
              good: true,
            });
          } else if (action === 'get_version_info') {
            actionResponse(ws, echo, 'ok', 0, {
              app_name: 'polaris-ntqq-loader',
              app_version: '0.0.1',
              protocol_version: 'v11',
            });
          } else if (action === 'get_group_member_info') {
            const groupId = Number(params.group_id) || 0;
            const userId = Number(params.user_id) || 0;
            actionResponse(ws, echo, 'ok', 0, {
              group_id: groupId,
              user_id: userId,
              nickname: String(userId),
              card: '',
              sex: 'unknown',
              age: 0,
              area: '',
              join_time: 0,
              last_sent_time: 0,
              level: '0',
              role: 'member',
              unfriendly: false,
              title: '',
              title_expire_time: 0,
              card_changeable: true,
            });
          } else if (action === 'get_stranger_info') {
            const userId = Number(params.user_id) || 0;
            actionResponse(ws, echo, 'ok', 0, {
              user_id: userId,
              nickname: String(userId),
              sex: 'unknown',
              age: 0,
            });
          } else if (action === 'get_group_info') {
            actionResponse(ws, echo, 'ok', 0, {
              group_id: Number(params.group_id) || 0,
              group_name: '',
              member_count: 0,
              max_member_count: 0,
            });
          } else if (
            action === 'send_private_msg' ||
            action === 'send_group_msg' ||
            action === 'send_msg'
          ) {
            await handleSend(ws, action, params, echo);
          } else {
            actionResponse(
              ws,
              echo,
              'failed',
              1404,
              null,
              'action not implemented in minimal adapter',
            );
          }
        } catch (error) {
          actionResponse(ws, echo, 'failed', 1500, null, String(error));
        }
      });
    });
    log({ kind: 'ws_started', host, port });
  }

  return {
    close() {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (wss) wss.close();
      clients.clear();
    },
  };
}

module.exports = { startOneBot };
