//////////////////////////////////////////////////////////////////////////////////////////
// 1. 地図の初期化（HTMLファイル読み込み時に実行）
//////////////////////////////////////////////////////////////////////////////////////////
const map = L.map('map').setView([35.1, 137.1], 13);     // https://leafletjs.com/reference.html#map-example を参照

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

// データストア
let allLocationsData = [];
let markersArray = [];

// DOM要素
const csvFileInput = document.getElementById('csvFile');
const dropZone = document.getElementById('dropZone');
const areaSelect = document.getElementById('areaFilter');
const districtSelect = document.getElementById('districtFilter');
const locationList = document.getElementById('locationList');
const dataSummary = document.getElementById('dataSummary');
const listTitle = document.getElementById('listTitle');

// イベント設定
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());
dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    const files = e.dataTransfer.files;
    if (files.length > 0 && files[0].name.endsWith('.csv')) handleFile(files[0]);
});
csvFileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) handleFile(e.target.files[0]);
});

//////////////////////////////////////////////////////////////////////////////////////////
// 2. ファイル読み込み
//////////////////////////////////////////////////////////////////////////////////////////
function handleFile(file) {
    const reader = new FileReader();
    reader.onload = function(e) { parseCSV(e.target.result); };
    reader.readAsText(file, 'UTF-8');
}

//////////////////////////////////////////////////////////////////////////////////////////
// 3. CSVデータ解析
//////////////////////////////////////////////////////////////////////////////////////////
function parseCSV(text) {
    const lines = text.split(/\r?\n/);
    if (lines.length < 2) return alert('データが足りません。');

    // ヘッダー（1行目）の正確な日本語列名に一致させる
    const headers = splitCSVLine(lines[0]).map(h => h.trim());
    const numIdx  = headers.findIndex(h => h === '台帳番号');
    const latIdx  = headers.findIndex(h => h === '緯度');
    const lngIdx  = headers.findIndex(h => h === '経度');
    const areaIdx = headers.findIndex(h => h === 'エリア');
    const distIdx = headers.findIndex(h => h === '行政区');
    const addrIdx = headers.findIndex(h => h === '所在地');

    if (latIdx === -1 || lngIdx === -1) {
        return alert('CSVファイル内に「緯度」および「経度」の列名が見つかりません。');
    }

    // 前回状態のリセット
    clearPreviousState();

    // 選択肢の重複除去用
    const uniqueAreas = new Set();
    const uniqueDistricts = new Set();

    for (let i = 1; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        
        const cells = splitCSVLine(lines[i]);
        const lat = parseFloat(cells[latIdx]);
        const lng = parseFloat(cells[lngIdx]);

        if (!isNaN(lat) && !isNaN(lng)) {
            const num  = numIdx  !== -1 && cells[numIdx]  ? cells[numIdx].trim()  : '-';
            const area = areaIdx !== -1 && cells[areaIdx] ? cells[areaIdx].trim() : '-';
            const dist = distIdx !== -1 && cells[distIdx] ? cells[distIdx].trim() : '-';
            const addr = addrIdx !== -1 && cells[addrIdx] ? cells[addrIdx].trim() : '-';

            if (area !== '-') uniqueAreas.add(area);
            if (dist !== '-') uniqueDistricts.add(dist);

            // オブジェクトとしてメモリに保存
            allLocationsData.push({ id: i, num, lat, lng, area, dist, addr });
        }
    }

    if (allLocationsData.length === 0) return alert('有効なデータがありません。');

    // 各セレクトボックスの選択肢を動的に生成
    buildDropdown(areaSelect, Array.from(uniqueAreas).sort(), 'エリア');
    buildDropdown(districtSelect, Array.from(uniqueDistricts).sort(), '行政区');

    // 初期表示（すべて表示）
    applyFilters();
    dataSummary.style.display = 'flex';
}

// 初期化処理
function clearPreviousState() {
    markersArray.forEach(m => map.removeLayer(m.instance));
    markersArray = [];
    allLocationsData = [];
    locationList.innerHTML = '';
    
    areaSelect.innerHTML = '<option value="all">-- すべてのエリアを表示 --</option>';
    areaSelect.disabled = true;
    districtSelect.innerHTML = '<option value="all">-- すべての行政区を表示 --</option>';
    districtSelect.disabled = true;
}

// CSVデータ分割処理
function splitCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') inQuotes = !inQuotes;
        else if (char === ',' && !inQuotes) {
            result.push(current.replace(/^"|"$/g, ''));
            current = '';
        } else current += char;
    }
    result.push(current.replace(/^"|"$/g, ''));
    return result;
}

// ドロップダウン生成
function buildDropdown(selectElement, items, labelName) {
    items.forEach(value => {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = `${labelName}: ${value}`;
        selectElement.appendChild(opt);
    });
    selectElement.disabled = false;
}

//////////////////////////////////////////////////////////////////////////////////////////
// 4. 2つのフィルター条件を元にデータを抽出・描画 (AND検索)
//////////////////////////////////////////////////////////////////////////////////////////
function applyFilters() {
    // 現在のマーカーとリストを一度まっさらに
    markersArray.forEach(m => map.removeLayer(m.instance));
    markersArray = [];
    locationList.innerHTML = '';

    const selectedArea = areaSelect.value;
    const selectedDistrict = districtSelect.value;

    const bounds = [];
    let matchCount = 0;

    allLocationsData.forEach(data => {
        // 条件チェック (エリアと行政区の両方が一致するか確認)
        const areaMatch = (selectedArea === 'all' || data.area === selectedArea);
        const districtMatch = (selectedDistrict === 'all' || data.dist === selectedDistrict);

        if (areaMatch && districtMatch) {
            
            // ポップアップ表示するコンテンツの設定
            const popupContent = `
                <div style="font-size: 0.9rem; min-width: 200px;">
                    <strong style="display:block; margin-bottom: 6px; border-bottom: 2px solid var(--accent-color); padding-bottom: 3px; color:var(--primary-color);">集積所詳細</strong>
                    <table class="popup-table">
                        <tr><th>台帳番号:</th><td>${data.num}</td></tr>
                        <tr><th>緯度:</th><td>${data.lat}</td></tr>
                        <tr><th>経度:</th><td>${data.lng}</td></tr>
                        <tr><th>エリア:</th><td>${data.area}</td></tr>
                        <tr><th>行政区:</th><td>${data.dist}</td></tr>
                        <tr><th>所在地:</th><td>${data.addr}</td></tr>
                    </table>
                </div>
            `;

            // マーカーを作成
            const marker = L.marker([data.lat, data.lng]);  // https://leafletjs.com/reference.html#marker を参照
            // マーカーにポップアップコンテンツを紐付け
            marker.bindPopup(popupContent);     // https://leafletjs.com/reference.html#layer-bindpopup を参照
            // マーカーを地図に配置
            marker.addTo(map);     // https://leafletjs.com/reference.html#marker を参照

            markersArray.push({ instance: marker });
            bounds.push([data.lat, data.lng]);

            // 対象地点一覧の表示
            const displayName = data.addr !== '-' ? data.addr : (data.num !== '-' ? `台帳No.${data.num}` : `地点 ${data.id}`);
            const li = document.createElement('li');
            li.textContent = `[No.${data.num}] ${displayName}`;
            li.addEventListener('click', () => {
                map.setView([data.lat, data.lng], 16);
                marker.openPopup();
            });
            locationList.appendChild(li);
            matchCount++;
        }
    });

    // 件数タイトルの更新
    listTitle.textContent = `対象地点一覧 (${matchCount}件)`;

    // 条件に該当するデータが存在すれば、その範囲へ地図を自動フィッティング
    if (bounds.length > 0) {
        map.fitBounds(bounds, {
            padding: [50, 50],
            maxZoom: 16
        });
    }
}

//////////////////////////////////////////////////////////////////////////////////////////
// 5. いずれかのフィルターが変更されたら再計算
//////////////////////////////////////////////////////////////////////////////////////////
areaSelect.addEventListener('change', applyFilters);
districtSelect.addEventListener('change', applyFilters);

