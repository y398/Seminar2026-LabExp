/**
 * GarbageTruckMap.html 用スクリプト
 * MQTT（WSS）でゴミ収集車の位置情報を受信し、Leaflet地図上に
 * 最新の位置情報のみをピンで表示する。
 *
 * 仕様:
 *  - MQTTブローカーの接続情報はこのファイル内に固定し、Webページ上からは変更不可とする。
 *  - サブスクライブするトピック名のみ、フォームから設定可能とする。
 *  - 新しい位置情報を受信したら、古いピンを削除し最新のピンのみ表示する。
 */

(() => {
  "use strict";

  // ===========================================================
  // MQTTブローカー接続設定（固定値・変更不可）
  // ===========================================================
  const MQTT_BROKER_HOST = "nisshin-gc.ucl.meijo-u.ac.jp";
  const MQTT_BROKER_PORT = 1880;
  const MQTT_WS_PATH = "/ws/mqtt";
  const MQTT_PROTOCOL = "wss"; // MQTTS over WebSocket

  const MQTT_BROKER_URL = `${MQTT_PROTOCOL}://${MQTT_BROKER_HOST}:${MQTT_BROKER_PORT}${MQTT_WS_PATH}`;

  // ===========================================================
  // 地図の初期化
  // ===========================================================
  const map = L.map("map").setView([35.13589771154396, 136.9754733734119], 13); // 日進市付近を初期表示

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
  }).addTo(map);

  // 塵芥車アイコン（マーカーを視覚的に区別しやすくする）
  const truckIcon = L.icon({
    iconUrl: "assets/icon-truck.png",
    iconSize: [64, 27],
    iconAnchor: [32, 27],
    popupAnchor: [0, -27]
  });

  // 現在地図上に表示している最新マーカー（塵芥車1台分=1ピン想定）
  // トピックごとに最新の1件のみ保持するため、トピック名をキーにしたMapで管理する。
  /** @type {Map<string, L.Marker>} */
  const latestMarkers = new Map();

  // サイドバーに表示する受信履歴（最新の状態のみをトピックごとに保持）
  /** @type {Map<string, {topic: string, lat: number, lng: number, receivedAt: Date, raw: any}>} */
  const latestRecords = new Map();

  // ===========================================================
  // DOM要素
  // ===========================================================
  const clientIdInput = document.getElementById("clientIdInput");
  const connectBtn = document.getElementById("connectBtn");
  const connectionStatusEl = document.getElementById("connectionStatus");
  const topicInput = document.getElementById("topicInput");
  const subscribeBtn = document.getElementById("subscribeBtn");
  const subscribeStatusEl = document.getElementById("subscribeStatus");
  const locationListEl = document.getElementById("locationList");

  /** @type {import("mqtt").MqttClient | null} */
  let mqttClient = null;

  // 現在サブスクライブ中のトピック一覧
  const subscribedTopics = new Set();

  // ===========================================================
  // UIヘルパー
  // ===========================================================
  function setConnectionStatus(state, message) {
    connectionStatusEl.textContent = message;
    connectionStatusEl.classList.remove(
      "status-connected",
      "status-connecting",
      "status-disconnected",
      "status-error"
    );
    connectionStatusEl.classList.add(`status-${state}`);
  }

  function setSubscribeStatus(state, message) {
    subscribeStatusEl.textContent = message;
    subscribeStatusEl.classList.remove(
      "status-connected",
      "status-connecting",
      "status-disconnected",
      "status-error"
    );
    subscribeStatusEl.classList.add(`status-${state}`);
  }

  function renderLocationList() {
    locationListEl.innerHTML = "";

    if (latestRecords.size === 0) {
      const li = document.createElement("li");
      li.className = "no-data-message";
      li.textContent = "まだ位置情報を受信していません";
      locationListEl.appendChild(li);
      return;
    }

    latestRecords.forEach((record) => {
      const li = document.createElement("li");
      li.className = "data-list-item";
      const timeText = record.receivedAt.toLocaleTimeString("ja-JP");
      li.innerHTML = `
        <strong>${escapeHtml(record.topic)}</strong><br>
        緯度: ${record.lat.toFixed(6)} / 経度: ${record.lng.toFixed(6)}<br>
        <span class="data-list-time">受信時刻: ${timeText}</span>
      `;
      locationListEl.appendChild(li);
    });
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // ===========================================================
  // 位置情報メッセージのパース
  // ===========================================================
  function parsePositionPayload(payloadStr) {
    let data;
    try {
      data = JSON.parse(payloadStr);
    } catch (e) {
      console.error("位置情報メッセージのJSON解析に失敗しました:", e, payloadStr);
      return null;
    }

    const lat = Number(data.LATITUDE ?? data.lat ?? data.latitude);
    const lng = Number(data.LONGITUDE ?? data.lng ?? data.lon ?? data.longitude);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      console.error("位置情報メッセージに緯度・経度が見つかりません:", data);
      return null;
    }

    return { lat, lng, raw: data };
  }

  // ===========================================================
  // 受信した位置情報をマップ・サイドバーに反映
  // ===========================================================
  function handlePositionUpdate(topic, payloadStr) {
    const parsed = parsePositionPayload(payloadStr);
    if (!parsed) return;

    const currentCenter = map.getCenter();
    const currentZoom = map.getZoom();

    const { lat, lng, raw } = parsed;
    const receivedAt = new Date();

    const identifier = raw.IDENTIFIER ?? topic;
    const dateText = raw.DATE ?? "-";
    const timeText = raw.TIME ?? "-";
    const altitudeText = raw.ALTITUDE ?? "-";
    const speedText = raw.SPEED ?? "-";
    const trackText = raw.TRACK ?? "-";

    const popupHtml = `
      <div class="truck-popup">
        <strong>${escapeHtml(String(identifier))}</strong><br>
        日付: ${escapeHtml(String(dateText))}<br>
        時刻: ${escapeHtml(String(timeText))}<br>
        緯度: ${lat.toFixed(6)}<br>
        経度: ${lng.toFixed(6)}<br>
        高度: ${escapeHtml(String(altitudeText))}<br>
        速度: ${escapeHtml(String(speedText))}<br>
        進行方向: ${escapeHtml(String(trackText))}
      </div>
    `;

    let marker = latestMarkers.get(topic);

    if (marker) {
      const popupWasOpen = marker.isPopupOpen();

      marker.setLatLng([lat, lng]);
      marker.setPopupContent(popupHtml);

      if (popupWasOpen) {
        marker.openPopup();
      }
    } else {
      marker = L.marker([lat, lng], { icon: truckIcon }).addTo(map);
      marker.bindPopup(popupHtml);
      latestMarkers.set(topic, marker);
    }

    latestRecords.set(topic, {
      topic,
      lat,
      lng,
      receivedAt,
      raw,
    });

    renderLocationList();
  }

  // ===========================================================
  // MQTT接続処理
  // ===========================================================
  function connectMqtt() {
    if (mqttClient) {
      // 既に接続済み/接続中の場合は何もしない
      return;
    }

    const clientId = clientIdInput.value.trim();
    if (!clientId) {
      window.alert("クライアントIDを入力してください。");
      return;
    }

    const MQTT_CONNECT_OPTIONS = Object.freeze({
      clientId: clientId,
      protocolVersion: 4,
      clean: true,
      connectTimeout: 10 * 1000, // 10秒（ミリ秒指定）
      username: String.fromCharCode(116, 102, 45, 110, 105, 115, 115, 104, 105, 110),
      password: String.fromCharCode(117, 98, 105, 108, 97, 98, 45, 82, 51, 52, 49, 50),
      reconnectPeriod: 4 * 1000, // 4秒（ミリ秒指定）
    });

    setConnectionStatus("connecting", "接続中...");
    connectBtn.disabled = true;

    mqttClient = mqtt.connect(MQTT_BROKER_URL, MQTT_CONNECT_OPTIONS);

    mqttClient.on("connect", () => {
      setConnectionStatus("connected", "接続済み");
      connectBtn.textContent = "接続済み";
      subscribeBtn.disabled = false;
    });

    mqttClient.on("reconnect", () => {
      setConnectionStatus("connecting", "再接続中...");
    });

    mqttClient.on("close", () => {
      setConnectionStatus("disconnected", "切断されました");
      subscribeBtn.disabled = true;
    });

    mqttClient.on("error", (err) => {
      console.error("MQTT接続エラー:", err);
      setConnectionStatus("error", "接続エラーが発生しました");
    });

    mqttClient.on("message", (topic, payload) => {
      handlePositionUpdate(topic, payload.toString());
    });
  }

  // ===========================================================
  // トピックのサブスクライブ処理
  // ===========================================================
  function subscribeToTopic() {
    const topic = topicInput.value.trim();

    if (!topic) {
      window.alert("トピック名を入力してください。");
      return;
    }

    if (!mqttClient || !mqttClient.connected) {
      window.alert("ブローカーに接続されていません。先に接続してください。");
      return;
    }

    if (subscribedTopics.has(topic)) {
      window.alert("このトピックは既にサブスクライブ済みです。");
      return;
    }

    setSubscribeStatus("connecting", `サブスクライブ中: ${topic}`);

    mqttClient.subscribe(topic, { qos: 0 }, (err) => {
      if (err) {
        console.error("サブスクライブに失敗しました:", err);
        setSubscribeStatus("error", "サブスクライブに失敗しました");
        return;
      }
      subscribedTopics.add(topic);
      setSubscribeStatus("connected", `サブスクライブ中: ${topic}`);
    });
  }

  // ===========================================================
  // イベントリスナー登録
  // ===========================================================
  connectBtn.addEventListener("click", connectMqtt);
  subscribeBtn.addEventListener("click", subscribeToTopic);

  // 初期表示
  setConnectionStatus("disconnected", "未接続");
  setSubscribeStatus("disconnected", "未サブスクライブ");
  renderLocationList();
})();
