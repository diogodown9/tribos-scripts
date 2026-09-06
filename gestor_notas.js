// ==UserScript==
// @name         Auto Set/Get Village Notes (Gestor de Notas TW - Barra de Acesso Rápido)
// @namespace    http://tampermonkey.net/
// @version      14.0
// @description  Verificação em tempo real do dono atual (ignora aldeias tuas mesmo em relatórios antigos) e limpeza definitiva. Adaptado para Barra de Acesso Rápido com navegação contínua AJAX.
// @author       RedAlert (Mod: JawJaw / Adaptado para Barra Rápida)
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
        DELAYS: { MIN: 200, MAX: 400 },
        STORAGE: {
            HISTORY: `tw_notas_history_${game_data.world}`,
            STATE: `tw_notas_running_${game_data.world}`,
            DB: `tw_notas_db_${game_data.world}`,
            OWNED: `tw_notas_owned_${game_data.world}`,
            ENEMIES: `tw_notas_enemies_${game_data.world}`,
            CLEANED: `tw_notas_cleaned_${game_data.world}`
        },
        UNITS: {
            POP: { spear: 1, sword: 1, axe: 1, archer: 1, spy: 2, light: 4, marcher: 5, heavy: 6, ram: 5, catapult: 8, knight: 10, snob: 100 },
            OFF: ['axe', 'light', 'marcher', 'ram', 'catapult'],
            DEF: ['spear', 'sword', 'archer', 'heavy']
        }
    };

    // ==========================================
    // 2. MÓDULO DE BASE DE DADOS
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
        clearHistory: () => {
            localStorage.removeItem(CFG.STORAGE.HISTORY);
            if (window.UI) window.UI.SuccessMessage('Histórico de relatórios limpo com sucesso.');
            setTimeout(() => location.reload(), 500);
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
        setState: (state) => localStorage.setItem(CFG.STORAGE.STATE, state ? 'true' : 'false')
    };

    // ==========================================
    // 3. EXTRATOR DE DADOS E HELPERS
    // ==========================================
    const Utils = {
        formatNum: (num) => parseInt(num).toLocaleString('de'),
        getParam: (name, searchStr) => new URLSearchParams(searchStr || window.location.search).get(name),
        delay: (min, max) => new Promise(res => setTimeout(res, Math.floor(Math.random() * (max - min + 1)) + min)),
        wrapBB: (text, type) => `[${type}]${text}[/${type}]`,

        parseVillageFromTable: (tableId) => {
            const tbl = document.getElementById(tableId);
            if (!tbl) return null;
            const text = tbl.rows[1]?.cells[1]?.textContent.trim() || '';
            const match = text.match(/(.+?)\s*\((\d{3}\|\d{3})\)\s*K\d{2}/);
            return { name: match ? match[1].trim() : text, raw: text, coord: match ? match[2] : '---' };
        },

        extractBuildings: () => {
            let wall = '?', farm = '?', tower = '?', hq = '?';
            const container = document.getElementById('ra-left-wrapper') || document.getElementById('content_value');
            const html = container ? container.innerHTML : '';
            const text = container ? (container.innerText || container.textContent) : '';

            const wallMatch = html.match(/building wall.*?(\d+)/i) || text.match(/Muralha\s*(?:Nível\s*)?(\d+)/i);
            const farmMatch = html.match(/building farm.*?(\d+)/i) || text.match(/Fazenda\s*(?:Nível\s*)?(\d+)/i);
            const towerMatch = html.match(/building watchtower.*?(\d+)/i) || text.match(/Torre de vigia\s*(?:Nível\s*)?(\d+)/i);
            const hqMatch = html.match(/building main.*?(\d+)/i) || text.match(/Edifício Principal\s*(?:Nível\s*)?(\d+)/i);

            if (wallMatch) wall = wallMatch[1];
            if (farmMatch) farm = farmMatch[1];
            if (towerMatch) tower = towerMatch[1];
            if (hqMatch) hq = hqMatch[1];

            let loyalty = null;
            const loyaltyMatch = text.match(/Lealdade desceu de \d+ para (-?\d+)/i);
            if (loyaltyMatch) loyalty = parseInt(loyaltyMatch[1]);

            let troopsOutside = false;
            const $awayTable = jQuery('#attack_spy_away');
            if ($awayTable.length) {
                $awayTable.find('tr').eq(1).find('td').each(function() {
                    const count = parseInt(jQuery(this).text().trim().replace(/\./g, '')) || 0;
                    if (count > 0) { troopsOutside = true; return false; }
                });
            }

            const hasInfo = html.includes('Espionagem') || html.includes('attack_spy');
            return { wall, farm, tower, hq, loyalty, troopsOutside, hasInfo };
        },

        buildFinalNote: (vData) => {
            let finalNote = '';
            if (vData.tags && vData.tags.length > 0) finalNote += `[b][u]TIPO DE ALDEIA[/u][/b]\n${vData.tags.join('\n')}\n\n`;
            if (vData.spy && vData.spy.text) finalNote += `[b][u]ÚLTIMA ESPIONAGEM[/u][/b]\n${vData.spy.text}\n\n`;

            if (vData.attacks && vData.attacks.length > 0) {
                finalNote += `[b][u]HISTÓRICO DE ATAQUES (NOSSOS)[/u][/b]\n` + vData.attacks.map(a => a.text || a).join('\n\n---\n\n') + '\n\n';
            }
            if (vData.outgoing && vData.outgoing.length > 0) {
                finalNote += `[b][u]ATAQUES LANÇADOS CONTRA NÓS[/u][/b]\n` + vData.outgoing.map(a => a.text || a).join('\n\n---\n\n') + '\n\n';
            }
            return finalNote.trim();
        }
    };

    // ==========================================
    // 4. CLASSIFICADOR DE ALDEIAS
    // ==========================================
    const TacticalEngine = {
        analyzeDefense: () => {
            let offPop = 0, defPop = 0, totalPop = 0, hasSnob = false;

            const countPop = (idx, countText) => {
                const count = parseInt(countText.replace(/\./g, '')) || 0;
                const unit = game_data.units[idx];
                if (unit && count > 0) {
                    const pop = count * (CFG.UNITS.POP[unit] || 1);
                    if (CFG.UNITS.OFF.includes(unit)) offPop += pop;
                    if (CFG.UNITS.DEF.includes(unit)) defPop += pop;
                    if (unit === 'snob') hasSnob = true;
                    totalPop += pop;
                }
            };

            jQuery('#attack_info_def tr').each(function() {
                const $row = jQuery(this);
                if ($row.find('td').eq(0).text().toLowerCase().includes('quantidade')) {
                    $row.find('td').each(function(idx) {
                        if (idx === 0) return;
                        countPop(idx - 1, jQuery(this).text().trim());
                    });
                }
            });

            const $spyTbl = jQuery('#attack_spy_def_troops');
            if ($spyTbl.length) {
                $spyTbl.find('tr').eq(1).find('td').each(function(idx) { countPop(idx, jQuery(this).text().trim()); });
            }

            const tags = [];
            if (hasSnob) tags.push('🔴 [ALVO - CONTÉM NOBRES]');
            if (offPop > CFG.HIGH_THREAT_POP) tags.push('💥 [FULL ATAQUE INIMIGO]');
            else if (defPop > CFG.HIGH_THREAT_POP) tags.push('🛡️ [BUNKER / FULL DEFESA]');
            else if (offPop > defPop * 1.5) tags.push('⚔️ [Aldeia Ofensiva]');
            else if (defPop > offPop * 1.5) tags.push('🛡️ [Aldeia Defensiva]');
            else if (offPop > 0 || defPop > 0) tags.push('⚖️ [Aldeia Mista]');

            return { tags, totalDefPop: totalPop };
        }
    };

    // ==========================================
    // 5. INTERFACE DO UTILIZADOR
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
                    ? `<span style="color: green; font-weight: bold;">✔ Processado</span>`
                    : `<button id="btn-manual" class="btn" style="width:100%;">Extrair Nota</button>`;

                const html = `
                    <table id="ra-notas-dashboard" class="vis" style="width: 100%; margin-bottom: 15px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
                        <tbody>
                            <tr>
                                <th>
                                    <div style="display: flex; justify-content: space-between;">
                                        <span>Gestor de Notas TW v13.6</span>
                                    </div>
                                </th>
                            </tr>
                            <tr>
                                <td style="text-align: center; padding: 10px;">
                                    <strong>Estado da Leitura:</strong><br>
                                    <div id="action-container" style="margin-top: 5px;">${statusBadge}</div>
                                    <div id="bot-progress-status" style="margin-top: 6px; font-size: 11px; color: #666;"></div>
                                </td>
                            </tr>
                            <tr>
                                <th style="text-align: center;">Navegação Automática</th>
                            </tr>
                            <tr>
                                <td style="padding: 10px; display: flex; flex-direction: column; gap: 5px;">
                                    <button id="btn-auto-start" class="btn">▶ Iniciar Leitura Automática</button>
                                    <button id="btn-auto-stop" class="btn btn-cancel" style="display: none;">⏹ Parar Bot</button>
                                </td>
                            </tr>
                            <tr>
                                <td style="text-align: center; padding: 8px;">
                                    <a href="#" id="btn-clear" style="font-size: 10px; color: #a52a2a;">🗑️ Limpar Memória de Leitura</a>
                                </td>
                            </tr>
                        </tbody>
                    </table>
                `;

                sidebar.innerHTML = html;

                document.getElementById('btn-manual')?.addEventListener('click', async (e) => {
                    e.target.disabled = true;
                    e.target.textContent = 'A processar...';
                    await Engine.process(false);
                });

                document.getElementById('btn-auto-start')?.addEventListener('click', async () => {
                    DB.setState(true);
                    UI.toggleAuto(true);
                    await Engine.runAutoLoop();
                });

                document.getElementById('btn-auto-stop')?.addEventListener('click', () => {
                    DB.setState(false);
                    UI.toggleAuto(false);
                    UI.setStatus("⏹ Bot parado.");
                });

                document.getElementById('btn-clear')?.addEventListener('click', (e) => {
                    e.preventDefault();
                    if (confirm("Redefinir memória de relatórios lidos?")) DB.clearHistory();
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
        }
    };

    // ==========================================
    // 6. MOTOR DE PROCESSAMENTO
    // ==========================================
    const Engine = {
        process: async (isAuto) => {
            const reportId = Utils.getParam('view');
            const reportIdNum = parseInt(reportId, 10);

            if (isAuto && DB.getHistory().includes(reportId)) {
                return 'already_read';
            }

            const $attTable = jQuery('table#attack_info_att');
            const $defTable = jQuery('table#attack_info_def');
            if (!$defTable.length || !$attTable.length) {
                DB.saveHistory(reportId);
                if (!isAuto && window.UI) window.UI.ErrorMessage("Sem informações de batalha válidas.");
                return 'no_battle';
            }

            const attVillageId = $attTable.find('span[data-id]').first().attr('data-id');
            const defVillageId = $defTable.find('span[data-id]').first().attr('data-id');

            const attackerName = $attTable[0].rows[0].cells[1].textContent.trim();
            const defenderName = $defTable[0].rows[0].cells[1].textContent.trim();
            const isSelfAttack = (attackerName === game_data.player.name && defenderName === game_data.player.name);

            // Auto-ataque puro: as duas aldeias são nossas.
            if (isSelfAttack) {
                if (attVillageId) DB.addOwned(attVillageId);
                if (defVillageId) DB.addOwned(defVillageId);

                DB.saveHistory(reportId);
                if (!isAuto) {
                    const actionEl = document.getElementById('action-container');
                    if (actionEl) actionEl.innerHTML = `<span style="color: gray; font-weight: bold;">Ignorado (Auto-Ataque)</span>`;
                }
                return 'self_attack';
            }

            // Identificar aldeia foco
            let focusVillageId = null;
            let isCounterIntel = false;

            if (attackerName === game_data.player.name) {
                focusVillageId = defVillageId; // Atacámos nós
            } else if (defenderName === game_data.player.name) {
                focusVillageId = attVillageId; // Defendemo-nos
                isCounterIntel = true;
            } else {
                focusVillageId = defVillageId;
            }

            if (!focusVillageId) return 'no_focus';

            // PASSO 1: Verificação em Tempo Real do Dono
            const dataExt = Utils.extractBuildings();
            const isConquest = (attackerName === game_data.player.name && dataExt.loyalty !== null && dataExt.loyalty <= 0);
            let focusIsOurs = false;

            if (isConquest) {
                DB.addOwned(focusVillageId);
                focusIsOurs = true;
            } else if (DB.isOwned(focusVillageId)) {
                focusIsOurs = true;
            } else if (DB.getKnownEnemies().includes(focusVillageId)) {
                focusIsOurs = false;
            } else {
                focusIsOurs = await new Promise(resolve => {
                    jQuery.get(`/game.php?screen=info_village&id=${focusVillageId}`, (html) => {
                        const ownerLink = jQuery(html).find('#content_value table.vis:first tr:contains("Jogador:") a').attr('href');
                        resolve(ownerLink && ownerLink.includes(`id=${game_data.player.id}`));
                    }).fail(() => resolve(false));
                });

                if (focusIsOurs) DB.addOwned(focusVillageId);
                else DB.addKnownEnemy(focusVillageId);
            }

            // PASSO 2: Aldeia Nossa -> Limpeza de notas antigas e bloqueio
            if (focusIsOurs) {
                if (!DB.isCleaned(focusVillageId)) {
                    await new Promise((resolve) => {
                        jQuery.get(`/game.php?screen=info_village&id=${focusVillageId}`, (html) => {
                            DB.markCleaned(focusVillageId);
                            if (html.includes('TIPO DE ALDEIA') || html.includes('HISTÓRICO DE ATAQUES') || html.includes('ATAQUES LANÇADOS') || html.includes('ÚLTIMA ESPIONAGEM')) {
                                DB.deleteVillage(focusVillageId);
                                TribalWars.post('info_village', { ajaxaction: 'edit_notes', id: focusVillageId }, { note: "" }, () => resolve());
                            } else {
                                resolve();
                            }
                        }).fail(() => resolve());
                    });
                }

                DB.saveHistory(reportId);
                if (!isAuto) {
                    const actionEl = document.getElementById('action-container');
                    if (actionEl) actionEl.innerHTML = `<span style="color: #005eb2; font-weight: bold;">🏰 Aldeia Nossa (Limpa e Ignorada)</span>`;
                }
                return 'cleaned';
            }

            // PASSO 3: Aldeia Inimiga -> Construir e guardar nota tática
            let reportTime = $defTable.closest('table').find('tr:eq(1) td:eq(1)').text().trim();
            if (!reportTime || reportTime.length > 50) {
                const timeTd = jQuery('#content_value table.vis:first tr:contains("Enviado"), #content_value table.vis:first tr:contains("Data")').find('td:last');
                if (timeTd.length) reportTime = timeTd.text().trim();
            }

            let nonSpyPopAtt = 0, offPopAtt = 0, defPopAtt = 0;
            jQuery('#attack_info_att_units tr:eq(1) td.unit-item').each(function(idx) {
                const count = parseInt(this.textContent.trim().replace(/\./g, '')) || 0;
                const unit = game_data.units[idx];
                if (!unit || count === 0) return;

                const pop = count * CFG.UNITS.POP[unit];
                if (unit !== 'spy') nonSpyPopAtt += pop;
                if (CFG.UNITS.OFF.includes(unit)) offPopAtt += pop;
                if (CFG.UNITS.DEF.includes(unit)) defPopAtt += pop;
            });
            const isFake = nonSpyPopAtt < CFG.FAKE_LIMIT;

            if (isCounterIntel) {
                const defData = Utils.parseVillageFromTable('attack_info_def');
                let block = `[b]Data:[/b] ${reportTime} | [b]Alvo:[/b] [coord]${defData ? defData.coord : '---'}[/coord]\n`;

                if (isFake) {
                    block += `[i]🤡 Fake enviado contra nós[/i]\n`;
                } else {
                    let inferredType = '⚖️ Mista';
                    if (offPopAtt > defPopAtt * 1.5) inferredType = '⚔️ Ofensiva';
                    else if (defPopAtt > offPopAtt * 1.5) inferredType = '🛡️ Defensiva';

                    if (offPopAtt > 0) block += `[b]Off recebida:[/b] ${Utils.formatNum(offPopAtt)} | `;
                    if (defPopAtt > 0) block += `[b]Def recebida:[/b] ${Utils.formatNum(defPopAtt)}\n`;
                    block += `[b]Classificação Detetada:[/b] ${inferredType}\n`;
                }
                block += `[url="${window.location.origin}/game.php?screen=report&mode=all&view=${reportId}"]Link do Relatório[/url]`;

                const vData = DB.getVillage(focusVillageId);
                vData.outgoing = vData.outgoing || [];
                vData.outgoing.push({ id: reportIdNum, text: block });
                vData.outgoing = vData.outgoing
                    .filter((v, i, a) => a.findIndex(t => t.id === v.id) === i)
                    .sort((a, b) => a.id - b.id)
                    .slice(-4);

                const finalNote = Utils.buildFinalNote(vData);
                DB.saveVillage(focusVillageId, vData);

                await new Promise((resolve) => {
                    TribalWars.post('info_village', { ajaxaction: 'edit_notes', id: focusVillageId }, { note: finalNote }, () => {
                        DB.saveHistory(reportId);
                        if (!isAuto) {
                            const actionEl = document.getElementById('action-container');
                            if (actionEl) actionEl.innerHTML = `<span style="color: green; font-weight: bold;">✔ Counter-Intel Guardada</span>`;
                        }
                        resolve();
                    });
                });
                return 'saved';
            } else {
                const hasSpyInfo = dataExt.hasInfo;
                const tacticalData = TacticalEngine.analyzeDefense();
                const playerBB = Utils.wrapBB(defenderName, 'player');

                let block = `[b]Data:[/b] ${reportTime} | [b]Dono:[/b] ${playerBB}\n`;
                if (isFake) block += `[i]Ataque Falso / Espionagem[/i]\n`;
                else {
                    if (offPopAtt > 0) block += `[b]Off enviada:[/b] ${Utils.formatNum(offPopAtt)} | `;
                    if (defPopAtt > 0) block += `[b]Def enviada:[/b] ${Utils.formatNum(defPopAtt)}\n`;
                    if (offPopAtt > 0 && defPopAtt === 0) block += `\n`;
                }

                if (hasSpyInfo) {
                    block += `[b]Muralha:[/b] ${dataExt.wall} | [b]Fazenda:[/b] ${dataExt.farm}`;
                    if (dataExt.tower !== '?') block += ` | [b]Torre:[/b] ${dataExt.tower}`;
                    if (dataExt.hq !== '?') block += ` | [b]EP:[/b] ${dataExt.hq}`;
                    block += `\n`;
                    if (dataExt.troopsOutside) block += `[b]⚠️ Contém tropas fora da aldeia[/b]\n`;
                }
                if (dataExt.loyalty !== null) {
                    block += `[b]📉 Lealdade:[/b] ${dataExt.loyalty}\n`;
                }

                const $export = $('#report_export_code');
                if ($export.length) block += '\n' + $export.html().trim() + '\n';
                block += `[url="${window.location.origin}/game.php?screen=report&mode=all&view=${reportId}"]Link do Relatório[/url]`;

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

                const finalNote = Utils.buildFinalNote(vData);

                if (!finalNote.trim() || (isFake && !hasSpyInfo)) {
                    DB.saveHistory(reportId);
                    if (!isAuto) {
                        const actionEl = document.getElementById('action-container');
                        if (actionEl) actionEl.innerHTML = `<span style="color: gray; font-weight: bold;">Lido (Sem info relevante)</span>`;
                    }
                    return 'skipped';
                }

                DB.saveVillage(focusVillageId, vData);

                await new Promise((resolve) => {
                    TribalWars.post('info_village', { ajaxaction: 'edit_notes', id: focusVillageId }, { note: finalNote }, () => {
                        DB.saveHistory(reportId);
                        if (!isAuto) {
                            const actionEl = document.getElementById('action-container');
                            if (actionEl) actionEl.innerHTML = `<span style="color: green; font-weight: bold;">✔ Nota Guardada</span>`;
                        }
                        resolve();
                    });
                });
                return 'saved';
            }
        },

        runAutoLoop: async () => {
            let count = 0;
            let saved = 0;

            while (DB.isRunning()) {
                const reportId = Utils.getParam('view');
                if (!reportId) {
                    DB.setState(false);
                    UI.toggleAuto(false);
                    break;
                }

                UI.setStatus(`Lendo relatório #${reportId}... [Lidos: ${count} | Salvos: ${saved}]`);

                const res = await Engine.process(true);
                count++;
                if (res === 'saved') saved++;

                UI.setStatus(`Lidos: ${count} | Notas Guardadas: ${saved}`);

                if (!DB.isRunning()) break;

                const nextBtn = document.getElementById('report-previous') || document.getElementById('report-prev');
                const nextHref = nextBtn ? nextBtn.getAttribute('href') : null;

                if (!nextHref) {
                    DB.setState(false);
                    UI.toggleAuto(false);
                    UI.setStatus(`✔ Concluído! [Lidos: ${count} | Salvos: ${saved}]`);
                    if (window.UI) window.UI.SuccessMessage('Leitura da pasta concluída.');
                    break;
                }

                await Utils.delay(CFG.DELAYS.MIN, CFG.DELAYS.MAX);
                if (!DB.isRunning()) break;

                try {
                    const html = await jQuery.get(nextHref);
                    const $newDoc = jQuery(html);
                    const newContent = $newDoc.find('#content_value').html();

                    if (newContent) {
                        const leftWrapper = document.getElementById('ra-left-wrapper');
                        if (leftWrapper) leftWrapper.innerHTML = newContent;
                    }

                    if (window.history && window.history.replaceState) {
                        window.history.replaceState(null, '', nextHref);
                    }
                } catch (e) {
                    console.error("[Gestor de Notas] Erro ao carregar relatório:", e);
                    DB.setState(false);
                    UI.toggleAuto(false);
                    if (window.UI) window.UI.ErrorMessage("Erro ao carregar o próximo relatório.");
                    break;
                }
            }
        }
    };

    // ==========================================
    // 7. RENDERIZAR NOTAS (Ecrã de Comando)
    // ==========================================
    const renderVillageNotes = () => {
        const anchor = document.querySelector('.village_anchor a');
        if (!anchor) return;

        jQuery.get(anchor.getAttribute('href'), (html) => {
            const noteHtml = jQuery(html).find('#own_village_note .village-note');
            if (noteHtml.length && !document.getElementById('ra-notas-cmd-box')) {
                const container = `
                    <table id="ra-notas-cmd-box" class="vis" style="width: 100%; margin-top: 15px;">
                        <tbody>
                            <tr><th>Dados Registados (Gestor de Notas)</th></tr>
                            <tr><td style="padding: 10px;">${noteHtml[0].children[1].innerHTML}</td></tr>
                        </tbody>
                    </table>
                `;
                document.querySelector('#content_value table')?.insertAdjacentHTML('afterend', container);
            }
        });
    };

    // ==========================================
    // 8. INICIALIZAÇÃO
    // ==========================================
    const init = () => {
        const screen = Utils.getParam('screen');
        const view = Utils.getParam('view');
        const id = Utils.getParam('id');

        if (screen === 'report' && view) {
            UI.renderDashboard(view, DB.getHistory().includes(view));
        } else if (screen === 'report' && !view) {
            const firstReport = document.querySelector('table#report_list a[href*="view="]');
            if (firstReport) {
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
