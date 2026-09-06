// ==UserScript==
// @name         Auto Set/Get Village Notes (Gestor de Notas TW - Barra de Acesso Rápido)
// @namespace    http://tampermonkey.net/
// @version      16.0
// @description  Verificação em tempo real do dono atual (ignora aldeias tuas mesmo em relatórios antigos) e limpeza definitiva. Adaptado para Barra de Acesso Rápido com navegação contínua AJAX e controlo rigoroso de tamanho de nota.
// @author       RedAlert (Mod: JawJaw / Refatorado para Barra Rápida)
// ==/UserScript==

(() => {
    'use strict';

    // ==========================================
    // 1. CONFIGURAÇÕES BASE
    // ==========================================
    const CFG = {
        FAKE_LIMIT: 250,
        HIGH_THREAT_POP: 18000,
        FARM_CAPACITY: 24000,
        MAX_NOTE_LENGTH: 4200, // Limite seguro para evitar rejeição do servidor TW (limite max: 5000)
        DELAYS: { MIN: 200, MAX: 400 },
        STORAGE: {
            HISTORY: `tw_notas_v2_history_${game_data.world}`,
            STATE: `tw_notas_running_${game_data.world}`,
            DB: `tw_notas_v2_db_${game_data.world}`,
            OWNED: `tw_notas_v2_owned_${game_data.world}`,
            ENEMIES: `tw_notas_v2_enemies_${game_data.world}`,
            CLEANED: `tw_notas_v2_cleaned_${game_data.world}`
        },
        UNITS: {
            POP: { spear: 1, sword: 1, axe: 1, archer: 1, spy: 2, light: 4, marcher: 5, heavy: 6, ram: 5, catapult: 8, knight: 10, snob: 100, militia: 0 },
            OFF: ['axe', 'light', 'marcher', 'ram', 'catapult'],
            DEF: ['spear', 'sword', 'archer', 'heavy']
        }
    };

    // ==========================================
    // 2. MÓDULO DE BASE DE DADOS (LOCALSTORAGE)
    // ==========================================
    const DB = {
        getHistory: () => JSON.parse(localStorage.getItem(CFG.STORAGE.HISTORY) || '[]'),
        saveHistory: (id) => {
            if (!id) return;
            const h = DB.getHistory();
            const strId = String(id);
            if (!h.includes(strId)) {
                h.push(strId);
                if (h.length > 3000) h.shift();
                localStorage.setItem(CFG.STORAGE.HISTORY, JSON.stringify(h));
            }
        },

        getOwned: () => JSON.parse(localStorage.getItem(CFG.STORAGE.OWNED) || '[]'),
        addOwned: (id) => {
            if (!id) return;
            const list = DB.getOwned();
            const strId = String(id);
            if (!list.includes(strId)) {
                list.push(strId);
                if (list.length > 1500) list.shift();
                localStorage.setItem(CFG.STORAGE.OWNED, JSON.stringify(list));
            }
        },
        isOwned: (id) => DB.getOwned().includes(String(id)),

        getKnownEnemies: () => JSON.parse(localStorage.getItem(CFG.STORAGE.ENEMIES) || '[]'),
        addKnownEnemy: (id) => {
            if (!id) return;
            const list = DB.getKnownEnemies();
            const strId = String(id);
            if (!list.includes(strId)) {
                list.push(strId);
                if (list.length > 3000) list.shift();
                localStorage.setItem(CFG.STORAGE.ENEMIES, JSON.stringify(list));
            }
        },

        getCleaned: () => JSON.parse(localStorage.getItem(CFG.STORAGE.CLEANED) || '[]'),
        markCleaned: (id) => {
            if (!id) return;
            const list = DB.getCleaned();
            const strId = String(id);
            if (!list.includes(strId)) {
                list.push(strId);
                if (list.length > 1500) list.shift();
                localStorage.setItem(CFG.STORAGE.CLEANED, JSON.stringify(list));
            }
        },
        isCleaned: (id) => DB.getCleaned().includes(String(id)),

        getVillage: (id) => {
            const db = JSON.parse(localStorage.getItem(CFG.STORAGE.DB) || '{}');
            const vData = db[id] || { spy: null, attacks: [], outgoing: [], tags: [] };
            if (typeof vData.spy === 'string') vData.spy = { id: 0, text: vData.spy };
            if (vData.attacks && vData.attacks.length > 0 && typeof vData.attacks[0] === 'string') {
                vData.attacks = vData.attacks.map((text, idx) => ({ id: idx, text }));
            }
            if (vData.outgoing && vData.outgoing.length > 0 && typeof vData.outgoing[0] === 'string') {
                vData.outgoing = vData.outgoing.map((text, idx) => ({ id: idx, text }));
            }
            return vData;
        },
        saveVillage: (id, data) => {
            const db = JSON.parse(localStorage.getItem(CFG.STORAGE.DB) || '{}');
            db[id] = data;
            localStorage.setItem(CFG.STORAGE.DB, JSON.stringify(db));
        },
        deleteVillage: (id) => {
            const db = JSON.parse(localStorage.getItem(CFG.STORAGE.DB) || '{}');
            delete db[id];
            localStorage.setItem(CFG.STORAGE.DB, JSON.stringify(db));
        },

        isRunning: () => localStorage.getItem(CFG.STORAGE.STATE) === 'true',
        setState: (state) => localStorage.setItem(CFG.STORAGE.STATE, state ? 'true' : 'false'),

        clearAll: () => {
            localStorage.removeItem(CFG.STORAGE.HISTORY);
            localStorage.removeItem(CFG.STORAGE.STATE);
            localStorage.removeItem(CFG.STORAGE.OWNED);
            localStorage.removeItem(CFG.STORAGE.ENEMIES);
            localStorage.removeItem(CFG.STORAGE.CLEANED);
            localStorage.removeItem(CFG.STORAGE.DB);
            if (window.UI) window.UI.SuccessMessage('Memória de leitura e cache limpos com sucesso!');
            setTimeout(() => location.reload(), 600);
        }
    };

    // ==========================================
    // 3. EXTRATOR DE DADOS E HELPERS
    // ==========================================
    const Utils = {
        formatNum: (num) => parseInt(num).toLocaleString('de'),
        getParam: (name, searchStr) => new URLSearchParams(searchStr || window.location.search).get(name),
        delay: (min, max) => new Promise(res => setTimeout(res, Math.floor(Math.random() * (max - min + 1)) + min)),
        wrapBB: (text, type) => `[${type}]${text}[/${type}]`,

        parseVillageFromTable: (doc, tableId) => {
            const tbl = doc.getElementById(tableId);
            if (!tbl) return null;
            const text = tbl.rows[1]?.cells[1]?.textContent.trim() || '';
            const match = text.match(/(.+?)\s*\((\d{3}\|\d{3})\)\s*K\d{2}/);
            return { name: match ? match[1].trim() : text, raw: text, coord: match ? match[2] : '---' };
        },

        extractVillageId: (doc, tableId) => {
            const tbl = doc.getElementById(tableId);
            if (!tbl) return null;
            // 1. Verificar data-id no span da aldeia
            const spanId = tbl.querySelector('span[data-id]')?.getAttribute('data-id');
            if (spanId) return spanId;
            // 2. Fallback: procurar link com id= da aldeia
            const link = tbl.querySelector('a[href*="screen=info_village"]')?.getAttribute('href');
            if (link) {
                const m = link.match(/[?&]id=(\d+)/);
                if (m) return m[1];
            }
            return null;
        },

        extractReportTime: (doc) => {
            const bodyText = doc.body ? (doc.body.innerText || doc.body.textContent || '') : '';
            // Procura "Tempo de batalha", "Enviado", ou "Data"
            const match = bodyText.match(/(?:Tempo de batalha|Enviado|Data)\s*[:\n\r\t]*([0-9]{2}[\/\.][a-z0-9\.]+[\/\.][0-9]{2,4}\s*(?:\([0-9:]+\)|[0-9:]+))/i);
            if (match) return match[1].trim();

            const timeTd = doc.querySelector('#content_value table.vis tr td:last-child');
            if (timeTd) {
                const txt = timeTd.textContent.trim();
                if (txt.length > 5 && txt.length < 50) return txt;
            }
            return '---';
        },

        extractBuildings: (doc) => {
            let wall = '?', farm = '?', tower = '?', hq = '?';
            const container = doc.getElementById('ra-left-wrapper') || doc.getElementById('content_value') || doc.body;
            const html = container ? container.innerHTML : '';
            const text = container ? (container.innerText || container.textContent) : '';

            // Detectar dano de aríetes / catapultas (ex: "Muralha danificada do nível 11 para o nível 0")
            const wallDmg = text.match(/Muralha danificada do nível \d+ para o nível (\d+)/i);
            const farmDmg = text.match(/Fazenda danificada do nível \d+ para o nível (\d+)/i);
            const towerDmg = text.match(/Torre de vigia danificada do nível \d+ para o nível (\d+)/i);
            const hqDmg = text.match(/Edifício Principal danificado do nível \d+ para o nível (\d+)/i);

            // Níveis por espionagem ou normais
            const wallMatch = wallDmg ? wallDmg[1] : (html.match(/building wall.*?(\d+)/i) || text.match(/Muralha\s*(?:<b>)?\(?Nível\s*(\d+)/i));
            const farmMatch = farmDmg ? farmDmg[1] : (html.match(/building farm.*?(\d+)/i) || text.match(/Fazenda\s*(?:<b>)?\(?Nível\s*(\d+)/i));
            const towerMatch = towerDmg ? towerDmg[1] : (html.match(/building watchtower.*?(\d+)/i) || text.match(/Torre de vigia\s*(?:<b>)?\(?Nível\s*(\d+)/i));
            const hqMatch = hqDmg ? hqDmg[1] : (html.match(/building main.*?(\d+)/i) || text.match(/Edifício Principal\s*(?:<b>)?\(?Nível\s*(\d+)/i));

            if (wallMatch) wall = typeof wallMatch === 'string' ? wallMatch : wallMatch[1];
            if (farmMatch) farm = typeof farmMatch === 'string' ? farmMatch : farmMatch[1];
            if (towerMatch) tower = typeof towerMatch === 'string' ? towerMatch : towerMatch[1];
            if (hqMatch) hq = typeof hqMatch === 'string' ? hqMatch : hqMatch[1];

            let loyalty = null;
            const loyaltyMatch = text.match(/Lealdade desceu de \d+ para (-?\d+)/i);
            if (loyaltyMatch) loyalty = parseInt(loyaltyMatch[1]);

            let troopsOutside = false;
            const awayTable = doc.getElementById('attack_spy_away');
            if (awayTable) {
                const cells = awayTable.querySelectorAll('tr:nth-child(2) td');
                cells.forEach(td => {
                    const count = parseInt(td.textContent.trim().replace(/\./g, '')) || 0;
                    if (count > 0) troopsOutside = true;
                });
            }

            const hasInfo = html.includes('Espionagem') || html.includes('attack_spy') || !!doc.getElementById('attack_spy_buildings') || !!doc.getElementById('attack_spy_resources');
            return { wall, farm, tower, hq, loyalty, troopsOutside, hasInfo };
        },

        extractUnits: (doc, tableSelector) => {
            let nonSpyPop = 0, offPop = 0, defPop = 0, totalPop = 0, hasSnob = false;
            const cells = doc.querySelectorAll(`${tableSelector} tr:nth-child(2) td.unit-item`);

            cells.forEach((td, idx) => {
                const count = parseInt(td.textContent.trim().replace(/\./g, '')) || 0;
                // Extrair unidade da classe ex: unit-item unit-item-axe
                const matchClass = td.className.match(/unit-item-([a-z]+)/);
                const unit = matchClass ? matchClass[1] : (game_data.units ? game_data.units[idx] : null);
                if (!unit || count === 0) return;

                const pop = count * (CFG.UNITS.POP[unit] || 1);
                if (unit !== 'spy') nonSpyPop += pop;
                if (CFG.UNITS.OFF.includes(unit)) offPop += pop;
                if (CFG.UNITS.DEF.includes(unit)) defPop += pop;
                if (unit === 'snob') hasSnob = true;
                totalPop += pop;
            });

            return { nonSpyPop, offPop, defPop, totalPop, hasSnob };
        },

        // Constrói e higieniza a nota para NUNCA exceder o limite de caracteres de Tribos
        buildSanitizedNote: (vData, maxLength = CFG.MAX_NOTE_LENGTH) => {
            const assemble = (includeSpoilers) => {
                let note = '';
                if (vData.tags && vData.tags.length > 0) {
                    note += `[b][u]TIPO DE ALDEIA[/u][/b]\n${vData.tags.join('\n')}\n\n`;
                }
                if (vData.spy && vData.spy.text) {
                    let spyText = vData.spy.text;
                    if (!includeSpoilers) spyText = spyText.replace(/\[spoiler\][\s\S]*?\[\/spoiler\]/gi, '').trim();
                    note += `[b][u]ÚLTIMA ESPIONAGEM[/u][/b]\n${spyText}\n\n`;
                }
                if (vData.attacks && vData.attacks.length > 0) {
                    const attackTexts = vData.attacks.map((a, idx) => {
                        let txt = a.text || a;
                        const isLatest = (idx === vData.attacks.length - 1);
                        if (!includeSpoilers || !isLatest) {
                            txt = txt.replace(/\[spoiler\][\s\S]*?\[\/spoiler\]/gi, '').trim();
                        }
                        return txt;
                    });
                    note += `[b][u]HISTÓRICO DE ATAQUES (NOSSOS)[/u][/b]\n${attackTexts.join('\n\n---\n\n')}\n\n`;
                }
                if (vData.outgoing && vData.outgoing.length > 0) {
                    const outTexts = vData.outgoing.map(a => a.text || a);
                    note += `[b][u]ATAQUES LANÇADOS CONTRA NÓS[/u][/b]\n${outTexts.join('\n\n---\n\n')}\n\n`;
                }
                return note.trim();
            };

            // 1. Tentar com spoiler no ataque mais recente
            let note = assemble(true);
            if (note.length <= maxLength) return note;

            // 2. Se for longo demais, remover spoilers para manter relatório leve
            note = assemble(false);
            if (note.length <= maxLength) return note;

            // 3. Se continuar longo, descartar ataques mais antigos
            const attacks = [...(vData.attacks || [])];
            while (attacks.length > 1 && note.length > maxLength) {
                attacks.shift();
                vData.attacks = attacks;
                note = assemble(false);
            }
            return note;
        }
    };

    // ==========================================
    // 4. CLASSIFICADOR DE DEFESAS
    // ==========================================
    const TacticalEngine = {
        analyzeDefense: (doc) => {
            const defUnits = Utils.extractUnits(doc, '#attack_info_def_units');
            const spyUnits = Utils.extractUnits(doc, '#attack_spy_def_troops');

            const totalOff = defUnits.offPop + spyUnits.offPop;
            const totalDef = defUnits.defPop + spyUnits.defPop;
            const hasSnob = defUnits.hasSnob || spyUnits.hasSnob;

            const tags = [];
            if (hasSnob) tags.push('🔴 [ALVO - CONTÉM NOBRES]');
            if (totalOff > CFG.HIGH_THREAT_POP) tags.push('💥 [FULL ATAQUE INIMIGO]');
            else if (totalDef > CFG.HIGH_THREAT_POP) tags.push('🛡️ [BUNKER / FULL DEFESA]');
            else if (totalOff > totalDef * 1.5) tags.push('⚔️ [Aldeia Ofensiva]');
            else if (totalDef > totalOff * 1.5) tags.push('🛡️ [Aldeia Defensiva]');
            else if (totalOff > 0 || totalDef > 0) tags.push('⚖️ [Aldeia Mista]');

            return { tags, totalDefPop: defUnits.totalPop + spyUnits.totalPop };
        }
    };

    // ==========================================
    // 5. SERVIÇO DE NOTAS TRIBAL WARS (AJAX)
    // ==========================================
    const NoteService = {
        // Envia a nota com proteção de timeout e fallback robusto
        save: (villageId, noteText) => {
            return new Promise((resolve) => {
                let finished = false;
                const finish = (success, msg) => {
                    if (!finished) {
                        finished = true;
                        resolve({ success, msg });
                    }
                };

                const timer = setTimeout(() => {
                    console.warn(`[Gestor de Notas] Timeout ao gravar nota na aldeia ${villageId}`);
                    finish(false, 'Tempo limite excedido ao gravar nota.');
                }, 6000);

                try {
                    TribalWars.post(
                        'info_village',
                        { ajaxaction: 'edit_notes', id: villageId },
                        { note: noteText },
                        (res) => {
                            clearTimeout(timer);
                            finish(true, 'Nota guardada com sucesso.');
                        },
                        (err) => {
                            clearTimeout(timer);
                            console.warn('[Gestor de Notas] TribalWars.post retornou erro, tentando fallback:', err);
                            // Fallback direto via jQuery.post com token CSRF
                            const postUrl = TribalWars.buildURL
                                ? TribalWars.buildURL('info_village', { ajaxaction: 'edit_notes', id: villageId })
                                : `/game.php?village=${game_data.village.id}&screen=info_village&ajaxaction=edit_notes&id=${villageId}`;

                            jQuery.post(postUrl, { note: noteText, h: game_data.csrf }, () => {
                                finish(true, 'Nota guardada com sucesso via fallback.');
                            }).fail((jqErr) => {
                                finish(false, 'Falha ao guardar nota: ' + (err || jqErr?.statusText || 'Erro no servidor'));
                            });
                        }
                    );
                } catch (e) {
                    clearTimeout(timer);
                    console.error('[Gestor de Notas] Exceção ao chamar TribalWars.post:', e);
                    finish(false, e.message);
                }
            });
        },

        // Verificação real-time do dono da aldeia com DOMParser
        checkOwner: async (villageId) => {
            return new Promise((resolve) => {
                const url = `/game.php?village=${game_data.village.id}&screen=info_village&id=${villageId}`;
                jQuery.get(url, (html) => {
                    try {
                        const doc = new (window.DOMParser || DOMParser)().parseFromString(html, 'text/html');
                        const rows = doc.querySelectorAll('#content_value table.vis tr');
                        let ownerId = null;
                        for (const tr of rows) {
                            const text = tr.textContent;
                            if (text.includes('Jogador:') || text.includes('Player:')) {
                                const a = tr.querySelector('a[href*="screen=info_player"]');
                                if (a) {
                                    const m = a.getAttribute('href').match(/[?&]id=(\d+)/);
                                    if (m) ownerId = m[1];
                                }
                                break;
                            }
                        }
                        const isOurs = (ownerId !== null && String(ownerId) === String(game_data.player.id));
                        const isBarbarian = (ownerId === null);
                        resolve({ isOurs, isBarbarian, ownerId });
                    } catch (e) {
                        resolve({ isOurs: false, isBarbarian: false, ownerId: null });
                    }
                }).fail(() => resolve({ isOurs: false, isBarbarian: false, ownerId: null }));
            });
        }
    };

    // ==========================================
    // 6. INTERFACE DO UTILIZADOR
    // ==========================================
    const UI = {
        setupSidebarLayout: () => {
            const existing = document.getElementById('ra-sidebar-wrapper');
            if (existing) return existing;

            const contentValue = document.getElementById('content_value');
            if (!contentValue) return null;

            contentValue.style.display = 'flex';
            contentValue.style.alignItems = 'flex-start';
            contentValue.style.gap = '15px';

            const leftWrapper = document.createElement('div');
            leftWrapper.id = 'ra-left-wrapper';
            leftWrapper.style.flex = '1';
            leftWrapper.style.minWidth = '0';

            while (contentValue.firstChild) leftWrapper.appendChild(contentValue.firstChild);

            const rightWrapper = document.createElement('div');
            rightWrapper.id = 'ra-sidebar-wrapper';
            rightWrapper.style.width = '320px';
            rightWrapper.style.flexShrink = '0';
            rightWrapper.style.marginTop = '65px';

            contentValue.appendChild(leftWrapper);
            contentValue.appendChild(rightWrapper);

            return rightWrapper;
        },

        renderDashboard: (reportId, isSaved) => {
            const sidebar = UI.setupSidebarLayout();
            if (!sidebar) return;

            let dashboard = document.getElementById('ra-notas-dashboard');
            if (!dashboard) {
                const statusBadge = isSaved
                    ? `<span style="color: green; font-weight: bold;">✔ Processado</span> <button id="btn-manual" class="btn" style="margin-top: 5px; width: 100%; font-size: 11px;">Reextrair Nota</button>`
                    : `<button id="btn-manual" class="btn" style="width:100%;">Extrair Nota</button>`;

                const html = `
                    <table id="ra-notas-dashboard" class="vis" style="width: 100%; margin-bottom: 15px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
                        <tbody>
                            <tr>
                                <th>
                                    <div style="display: flex; justify-content: space-between; align-items: center;">
                                        <span>Gestor de Notas TW v16.0</span>
                                        <span style="font-size: 9px; color: #666;">PT114</span>
                                    </div>
                                </th>
                            </tr>
                            <tr>
                                <td style="text-align: center; padding: 10px;">
                                    <strong>Estado da Leitura:</strong><br>
                                    <div id="action-container" style="margin-top: 5px;">${statusBadge}</div>
                                    <div id="bot-progress-status" style="margin-top: 6px; font-size: 11px; color: #555;"></div>
                                </td>
                            </tr>
                            <tr>
                                <th style="text-align: center;">Navegação Automática</th>
                            </tr>
                            <tr>
                                <td style="padding: 10px; display: flex; flex-direction: column; gap: 6px;">
                                    <button id="btn-auto-start" class="btn btn-default">▶ Iniciar Leitura Automática</button>
                                    <button id="btn-auto-stop" class="btn btn-cancel" style="display: none;">⏹ Parar Bot</button>
                                </td>
                            </tr>
                            <tr>
                                <td style="text-align: center; padding: 8px;">
                                    <a href="#" id="btn-clear" style="font-size: 11px; color: #a52a2a; text-decoration: underline;">🗑️ Limpar Memória e Cache</a>
                                </td>
                            </tr>
                        </tbody>
                    </table>
                `;

                sidebar.innerHTML = html;

                document.getElementById('btn-manual')?.addEventListener('click', async (e) => {
                    const btn = e.target;
                    btn.disabled = true;
                    btn.textContent = 'A processar...';
                    await Engine.process(false, document);
                    btn.disabled = false;
                });

                document.getElementById('btn-auto-start')?.addEventListener('click', async () => {
                    DB.setState(true);
                    UI.toggleAuto(true);
                    await Engine.runAutoLoop();
                });

                document.getElementById('btn-auto-stop')?.addEventListener('click', () => {
                    DB.setState(false);
                    UI.toggleAuto(false);
                    UI.setStatus("⏹ Bot interrompido pelo utilizador.");
                });

                document.getElementById('btn-clear')?.addEventListener('click', (e) => {
                    e.preventDefault();
                    if (confirm("Tens a certeza que queres limpar todo o histórico de leitura e caches de aldeias?")) {
                        DB.clearAll();
                    }
                });
            }

            if (DB.isRunning()) {
                UI.toggleAuto(true);
                Engine.runAutoLoop();
            }
        },

        toggleAuto: (isRunning) => {
            const startBtn = document.getElementById('btn-auto-start');
            const stopBtn = document.getElementById('btn-auto-stop');
            if (startBtn) startBtn.style.display = isRunning ? 'none' : 'block';
            if (stopBtn) stopBtn.style.display = isRunning ? 'block' : 'none';
        },

        setStatus: (msg) => {
            const el = document.getElementById('bot-progress-status');
            if (el) el.innerHTML = msg;
        },

        setActionStatus: (htmlContent) => {
            const el = document.getElementById('action-container');
            if (el) el.innerHTML = htmlContent;
        }
    };

    // ==========================================
    // 7. MOTOR DE PROCESSAMENTO
    // ==========================================
    const Engine = {
        process: async (isAuto, targetDoc = document, reportIdOverride = null) => {
            const reportId = reportIdOverride || Utils.getParam('view') || targetDoc.querySelector('a[href*="view="]')?.getAttribute('href')?.match(/[?&]view=(\d+)/)?.[1];
            const reportIdNum = parseInt(reportId, 10);

            if (isAuto && DB.getHistory().includes(String(reportId))) {
                return 'already_read';
            }

            const attTable = targetDoc.getElementById('attack_info_att');
            const defTable = targetDoc.getElementById('attack_info_def');

            if (!attTable || !defTable) {
                DB.saveHistory(reportId);
                if (!isAuto && window.UI) window.UI.ErrorMessage("Sem informações de batalha válidas neste relatório.");
                return 'no_battle';
            }

            const attVillageId = Utils.extractVillageId(targetDoc, 'attack_info_att');
            const defVillageId = Utils.extractVillageId(targetDoc, 'attack_info_def');

            // Detetar atacante e defensor
            const attPlayerLink = attTable.querySelector('a[href*="screen=info_player"]');
            const defPlayerLink = defTable.querySelector('a[href*="screen=info_player"]');

            const attPlayerId = attPlayerLink?.getAttribute('href')?.match(/[?&]id=(\d+)/)?.[1] || null;
            const defPlayerId = defPlayerLink?.getAttribute('href')?.match(/[?&]id=(\d+)/)?.[1] || null;

            const attackerName = attTable.rows[0]?.cells[1]?.textContent.trim() || '';
            const defenderName = defTable.rows[0]?.cells[1]?.textContent.trim() || '';

            const isAttackerUs = (attPlayerId && String(attPlayerId) === String(game_data.player.id)) || (attackerName === game_data.player.name);
            const isDefenderUs = (defPlayerId && String(defPlayerId) === String(game_data.player.id)) || (defenderName === game_data.player.name);
            const isSelfAttack = (isAttackerUs && isDefenderUs);

            // Auto-ataque: ambas as aldeias são nossas
            if (isSelfAttack) {
                if (attVillageId) DB.addOwned(attVillageId);
                if (defVillageId) DB.addOwned(defVillageId);
                DB.saveHistory(reportId);
                if (!isAuto) {
                    UI.setActionStatus(`<span style="color: gray; font-weight: bold;">Ignorado (Auto-Ataque)</span>`);
                }
                return 'self_attack';
            }

            // Identificar aldeia foco e ignorar aldeias bárbaras (notas aplicam-se apenas a jogadores)
            let focusVillageId = null;
            let isCounterIntel = false;

            if (isAttackerUs) {
                focusVillageId = defVillageId; // Atacámos o alvo
                const isBarbarianReport = !defPlayerLink || !defenderName || defenderName === '---' || defenderName.toLowerCase().includes('bárbar') || defenderName.toLowerCase().includes('barbar');
                if (isBarbarianReport) {
                    DB.saveHistory(reportId);
                    if (!isAuto) {
                        UI.setActionStatus(`<span style="color: gray; font-weight: bold;">Ignorado (Aldeia Bárbara)</span>`);
                        if (window.UI) window.UI.InfoMessage("Aldeia bárbara ignorada — notas aplicam-se apenas a jogadores.");
                    }
                    return 'barbarian';
                }
            } else if (isDefenderUs) {
                focusVillageId = attVillageId; // Inimigo atacou-nos (Counter-Intel)
                isCounterIntel = true;
                const isBarbarianAttacker = !attPlayerLink || !attackerName || attackerName === '---' || attackerName.toLowerCase().includes('bárbar');
                if (isBarbarianAttacker) {
                    DB.saveHistory(reportId);
                    return 'barbarian';
                }
            } else {
                focusVillageId = defVillageId;
            }

            if (!focusVillageId) {
                if (!isAuto && window.UI) window.UI.ErrorMessage("Não foi possível identificar o ID da aldeia.");
                return 'no_focus';
            }

            // PASSO 1: Verificação em Tempo Real do Dono
            const dataExt = Utils.extractBuildings(targetDoc);
            const isConquest = (isAttackerUs && dataExt.loyalty !== null && dataExt.loyalty <= 0);
            let focusIsOurs = false;

            if (isConquest) {
                DB.addOwned(focusVillageId);
                focusIsOurs = true;
            } else if (DB.isOwned(focusVillageId)) {
                focusIsOurs = true;
            } else if (DB.getKnownEnemies().includes(focusVillageId)) {
                focusIsOurs = false;
            } else {
                // Consultar a aldeia no servidor para verificar o proprietário atual
                const check = await NoteService.checkOwner(focusVillageId);
                if (check.isBarbarian) {
                    DB.saveHistory(reportId);
                    if (!isAuto) {
                        UI.setActionStatus(`<span style="color: gray; font-weight: bold;">Ignorado (Aldeia Bárbara)</span>`);
                        if (window.UI) window.UI.InfoMessage("Aldeia bárbara ignorada — notas aplicam-se apenas a jogadores.");
                    }
                    return 'barbarian';
                }

                focusIsOurs = check.isOurs;
                if (focusIsOurs) DB.addOwned(focusVillageId);
                else DB.addKnownEnemy(focusVillageId);
            }

            // PASSO 2: Aldeia Nossa -> Limpeza de notas antigas e bloqueio
            if (focusIsOurs) {
                if (!DB.isCleaned(focusVillageId)) {
                    DB.markCleaned(focusVillageId);
                    DB.deleteVillage(focusVillageId);
                    await NoteService.save(focusVillageId, '');
                }

                DB.saveHistory(reportId);
                if (!isAuto) {
                    UI.setActionStatus(`<span style="color: #005eb2; font-weight: bold;">🏰 Aldeia Nossa (Limpa e Ignorada)</span>`);
                    if (window.UI) window.UI.InfoMessage("Aldeia conquistada ou própria. Notas de ataque limpas.");
                }
                return 'cleaned';
            }

            // PASSO 3: Aldeia Inimiga -> Extrair Tropas e Construir Nota
            const reportTime = Utils.extractReportTime(targetDoc);
            const attUnits = Utils.extractUnits(targetDoc, '#attack_info_att_units');
            const isFake = attUnits.nonSpyPop < CFG.FAKE_LIMIT;

            if (isCounterIntel) {
                // COUNTER-INTEL (Aldeia inimiga que nos atacou)
                const defData = Utils.parseVillageFromTable(targetDoc, 'attack_info_def');
                let block = `[b]Data:[/b] ${reportTime} | [b]Alvo:[/b] [coord]${defData ? defData.coord : '---'}[/coord]\n`;

                if (isFake) {
                    block += `[i]🤡 Fake enviado contra nós[/i]\n`;
                } else {
                    let inferredType = '⚖️ Mista';
                    if (attUnits.offPop > attUnits.defPop * 1.5) inferredType = '⚔️ Ofensiva';
                    else if (attUnits.defPop > attUnits.offPop * 1.5) inferredType = '🛡️ Defensiva';

                    if (attUnits.offPop > 0) block += `[b]Off recebida:[/b] ${Utils.formatNum(attUnits.offPop)} | `;
                    if (attUnits.defPop > 0) block += `[b]Def recebida:[/b] ${Utils.formatNum(attUnits.defPop)}\n`;
                    block += `[b]Classificação Detetada:[/b] ${inferredType}\n`;
                }
                block += `[url="${window.location.origin}/game.php?village=${game_data.village.id}&screen=report&mode=all&view=${reportId}"]Link do Relatório[/url]`;

                const vData = DB.getVillage(focusVillageId);
                vData.outgoing = vData.outgoing || [];
                vData.outgoing.push({ id: reportIdNum, text: block });
                vData.outgoing = vData.outgoing
                    .filter((v, i, a) => a.findIndex(t => t.id === v.id) === i)
                    .sort((a, b) => a.id - b.id)
                    .slice(-4);

                const finalNote = Utils.buildSanitizedNote(vData);
                DB.saveVillage(focusVillageId, vData);

                const saveRes = await NoteService.save(focusVillageId, finalNote);
                if (saveRes.success) {
                    DB.saveHistory(reportId);
                    if (!isAuto) {
                        UI.setActionStatus(`<span style="color: green; font-weight: bold;">✔ Counter-Intel Guardada</span>`);
                        if (window.UI) window.UI.SuccessMessage('Counter-Intel guardada na aldeia inimiga!');
                    }
                    return 'saved';
                } else {
                    if (!isAuto) {
                        UI.setActionStatus(`<span style="color: red; font-weight: bold;">❌ Erro ao Gravar</span>`);
                        if (window.UI) window.UI.ErrorMessage('Erro ao gravar nota: ' + saveRes.msg);
                    }
                    return 'error';
                }
            } else {
                // ATAQUE NOSSO CONTRA ALDEIA DE JOGADOR INIMIGO
                const hasSpyInfo = dataExt.hasInfo;
                const tacticalData = TacticalEngine.analyzeDefense(targetDoc);
                const playerBB = Utils.wrapBB(defenderName, 'player');

                let block = `[b]Data:[/b] ${reportTime} | [b]Dono:[/b] ${playerBB}\n`;
                if (isFake) {
                    block += `[i]Ataque Falso / Espionagem[/i]\n`;
                } else {
                    if (attUnits.offPop > 0) block += `[b]Off enviada:[/b] ${Utils.formatNum(attUnits.offPop)} | `;
                    if (attUnits.defPop > 0) block += `[b]Def enviada:[/b] ${Utils.formatNum(attUnits.defPop)}\n`;
                    if (attUnits.offPop > 0 && attUnits.defPop === 0) block += `\n`;
                }

                if (hasSpyInfo) {
                    block += `[b]Muralha:[/b] ${dataExt.wall} | [b]Fazenda:[/b] ${dataExt.farm}`;
                    if (dataExt.tower !== '?') block += ` | [b]Torre:[/b] ${dataExt.tower}`;
                    if (dataExt.hq !== '?') block += ` | [b]EP:[/b] ${dataExt.hq}`;
                    block += `\n`;
                    if (dataExt.troopsOutside) block += `[b]⚠️ Contém tropas fora da aldeia[/b]\n`;
                } else if (dataExt.wall !== '?') {
                    block += `[b]Muralha:[/b] ${dataExt.wall}\n`;
                }

                if (dataExt.loyalty !== null) {
                    block += `[b]📉 Lealdade:[/b] ${dataExt.loyalty}\n`;
                }

                // Export code do relatório (se existir)
                const exportEl = targetDoc.getElementById('report_export_code');
                const exportCode = exportEl ? (exportEl.value || exportEl.innerHTML || '').trim() : '';
                if (exportCode) {
                    block += '\n' + exportCode + '\n';
                }

                block += `[url="${window.location.origin}/game.php?village=${game_data.village.id}&screen=report&mode=all&view=${reportId}"]Link do Relatório[/url]`;

                const vData = DB.getVillage(focusVillageId);
                if (tacticalData.tags.length > 0) vData.tags = tacticalData.tags;

                if (!isFake) {
                    vData.attacks = vData.attacks || [];
                    vData.attacks.push({ id: reportIdNum, text: block });
                    vData.attacks = vData.attacks
                        .filter((v, i, a) => a.findIndex(t => t.id === v.id) === i)
                        .sort((a, b) => a.id - b.id)
                        .slice(-4);

                    if (hasSpyInfo && (!vData.spy || reportIdNum > vData.spy.id)) {
                        vData.spy = { id: reportIdNum, text: block };
                    }
                } else if (hasSpyInfo && (!vData.spy || reportIdNum > vData.spy.id)) {
                    vData.spy = { id: reportIdNum, text: block };
                }

                // Se em modo automático e for um fake puro sem informação útil (sem espionagem, sem dano, sem tropas detetadas), ignorar
                const hasWallDmg = dataExt.wall !== '?';
                const hasDefTroops = tacticalData.totalDefPop > 0;
                const isConquestProgress = dataExt.loyalty !== null;
                const isRelevantAttack = (!isFake) || hasSpyInfo || hasWallDmg || hasDefTroops || isConquestProgress;

                if (isAuto && !isRelevantAttack) {
                    DB.saveHistory(reportId);
                    return 'skipped';
                }

                const finalNote = Utils.buildSanitizedNote(vData);

                if (!finalNote.trim()) {
                    DB.saveHistory(reportId);
                    if (!isAuto) {
                        UI.setActionStatus(`<span style="color: gray; font-weight: bold;">Lido (Sem info relevante)</span>`);
                    }
                    return 'skipped';
                }

                DB.saveVillage(focusVillageId, vData);

                const saveRes = await NoteService.save(focusVillageId, finalNote);
                if (saveRes.success) {
                    DB.saveHistory(reportId);
                    if (!isAuto) {
                        UI.setActionStatus(`<span style="color: green; font-weight: bold;">✔ Nota Guardada</span>`);
                        if (window.UI) window.UI.SuccessMessage('Nota guardada na aldeia alvo!');
                    }
                    return 'saved';
                } else {
                    if (!isAuto) {
                        UI.setActionStatus(`<span style="color: red; font-weight: bold;">❌ Erro ao Gravar</span>`);
                        if (window.UI) window.UI.ErrorMessage('Erro ao gravar nota: ' + saveRes.msg);
                    }
                    return 'error';
                }
            }
        },

        runAutoLoop: async () => {
            let count = 0;
            let saved = 0;
            let barbs = 0;
            let currentReportId = Utils.getParam('view') || document.querySelector('a[href*="view="]')?.getAttribute('href')?.match(/[?&]view=(\d+)/)?.[1];
            let currentDoc = document;

            while (DB.isRunning()) {
                if (!currentReportId) {
                    DB.setState(false);
                    UI.toggleAuto(false);
                    break;
                }

                UI.setStatus(`A ler relatório #${currentReportId}... [Lidos: ${count} | Players: ${saved} | Bárbaras: ${barbs}]`);

                const res = await Engine.process(true, currentDoc, currentReportId);
                count++;
                if (res === 'saved') saved++;
                else if (res === 'barbarian') barbs++;

                UI.setStatus(`Lidos: ${count} | Notas em Players: ${saved} | Bárbaras ignoradas: ${barbs}`);

                if (!DB.isRunning()) break;

                // Encontrar o botão do relatório seguinte (mais antigo) a partir do DOM atual
                const nextBtn = currentDoc.getElementById('report-prev') || currentDoc.getElementById('report-previous') || currentDoc.querySelector('a.report-nav-btn[data-direction="prev"]');

                let nextUrl = null;
                let nextReportId = null;
                if (nextBtn) {
                    const nextId = nextBtn.getAttribute('data-id');
                    if (nextId) {
                        nextReportId = nextId;
                        const mode = Utils.getParam('mode') || 'all';
                        const group = Utils.getParam('group_id') || '0';
                        nextUrl = `/game.php?village=${game_data.village.id}&screen=report&mode=${mode}&group_id=${group}&view=${nextId}`;
                    } else {
                        const href = nextBtn.getAttribute('href');
                        if (href && href !== '#' && href.includes('view=')) {
                            nextUrl = href;
                            nextReportId = Utils.getParam('view', href);
                        }
                    }
                }

                if (!nextUrl || !nextReportId || String(nextReportId) === String(currentReportId)) {
                    DB.setState(false);
                    UI.toggleAuto(false);
                    UI.setStatus(`✔ Concluído! [Lidos: ${count} | Notas em Players: ${saved} | Bárbaras ignoradas: ${barbs}]`);
                    if (window.UI) window.UI.SuccessMessage(`Leitura da pasta concluída! Total verificados: ${count} | Notas em Players: ${saved} | Bárbaras ignoradas: ${barbs}`);
                    break;
                }

                await Utils.delay(CFG.DELAYS.MIN, CFG.DELAYS.MAX);
                if (!DB.isRunning()) break;

                try {
                    const html = await jQuery.get(nextUrl);
                    const newDoc = new (window.DOMParser || DOMParser)().parseFromString(html, 'text/html');
                    const newContent = newDoc.querySelector('#content_value');

                    if (newContent) {
                        const leftWrapper = document.getElementById('ra-left-wrapper');
                        if (leftWrapper) {
                            leftWrapper.innerHTML = newContent.innerHTML;
                        }
                    }

                    currentDoc = newDoc;
                    currentReportId = nextReportId;

                    if (window.history && window.history.replaceState) {
                        window.history.replaceState(null, '', nextUrl);
                    }
                } catch (e) {
                    console.error("[Gestor de Notas] Erro ao carregar relatório:", e);
                    DB.setState(false);
                    UI.toggleAuto(false);
                    if (window.UI) window.UI.ErrorMessage("Erro ao carregar o próximo relatório via AJAX.");
                    break;
                }
            }
        }
    };

    // ==========================================
    // 8. RENDERIZAR NOTAS (Ecrã de Comando)
    // ==========================================
    const renderVillageNotes = () => {
        const anchor = document.querySelector('.village_anchor a');
        if (!anchor) return;

        jQuery.get(anchor.getAttribute('href'), (html) => {
            try {
                const doc = new (window.DOMParser || DOMParser)().parseFromString(html, 'text/html');
                const noteElem = doc.querySelector('#own_village_note .village-note, #village_notes .village-note, .village-note');
                if (noteElem && !document.getElementById('ra-notas-cmd-box')) {
                    const container = `
                        <table id="ra-notas-cmd-box" class="vis" style="width: 100%; margin-top: 15px;">
                            <tbody>
                                <tr><th>Dados Registados (Gestor de Notas)</th></tr>
                                <tr><td style="padding: 10px;">${noteElem.innerHTML}</td></tr>
                            </tbody>
                        </table>
                    `;
                    document.querySelector('#content_value table')?.insertAdjacentHTML('afterend', container);
                }
            } catch (e) {
                console.error('[Gestor de Notas] Erro ao renderizar notas de comando:', e);
            }
        });
    };

    // ==========================================
    // 9. INICIALIZAÇÃO
    // ==========================================
    const init = () => {
        const screen = Utils.getParam('screen');
        const view = Utils.getParam('view');
        const id = Utils.getParam('id');

        if (screen === 'report' && view) {
            UI.renderDashboard(view, DB.getHistory().includes(String(view)));
        } else if (screen === 'report' && !view) {
            const firstReport = document.querySelector('table#report_list a[href*="view="]');
            if (firstReport) {
                if (window.UI) window.UI.InfoMessage("A abrir o primeiro relatório da lista...");
                firstReport.click();
            } else {
                if (window.UI) window.UI.InfoMessage("Abre um relatório da pasta e clica novamente no script.");
            }
        } else if (screen === 'info_command' && id) {
            renderVillageNotes();
        } else {
            if (window.UI) window.UI.ErrorMessage("Abre um relatório ou comando antes de clicar no script!");
        }
    };

    init();

})();
