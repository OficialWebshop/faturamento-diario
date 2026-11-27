(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.GOAL_REVEAL = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const GOAL_REVEAL_DATE = '2026-11-27';

  function num(value) {
    const parsed = Number(value || 0);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function isGoalRevealActive(requestedDate, todayDate) {
    return String(requestedDate || '') === GOAL_REVEAL_DATE && String(todayDate || '') === GOAL_REVEAL_DATE;
  }

  function snapshotTotalGmv(snapshot) {
    return Object.values(snapshot?.channels || {}).reduce((sum, value) => sum + num(value), 0);
  }

  function createEmptyGoalRevealState(dataDate = GOAL_REVEAL_DATE) {
    return {
      dataDate,
      revealed: false,
      revealedAt: null,
      preGoalSnapshots: []
    };
  }

  function stripGoalReached(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return snapshot;
    const copy = { ...snapshot };
    delete copy.goalReached;
    if (copy.financial && typeof copy.financial === 'object') {
      const financialCopy = { ...copy.financial };
      delete financialCopy.goalReached;
      copy.financial = financialCopy;
    }
    return copy;
  }

  function sanitizePreGoalSnapshots(snapshots) {
    return (Array.isArray(snapshots) ? snapshots : []).map(stripGoalReached);
  }

  function snapshotsSignature(snapshots) {
    const list = Array.isArray(snapshots) ? snapshots : [];
    const last = list.at(-1);
    return JSON.stringify({
      count: list.length,
      at: last?.at || null,
      reconciledAt: last?.reconciledAt || null,
      slot: last?.slot || null,
      gmv: last ? snapshotTotalGmv(last) : 0,
      analyticsCount: Array.isArray(last?.analytics) ? last.analytics.length : 0
    });
  }

  function buildSyntheticPreGoalSnapshot(snapshot, target, summarizeFinancial) {
    const goalTarget = num(target);
    const clean = stripGoalReached(snapshot || {});
    if (!(goalTarget > 0)) return clean;

    const analytics = Array.isArray(clean.analytics) ? clean.analytics : [];
    if (analytics.length > 0) {
      let runningGmv = 0;
      const selectedAnalytics = [];
      for (const row of analytics) {
        if (!row?.contabilizado) {
          selectedAnalytics.push(row);
          continue;
        }
        const value = num(row.valor);
        if (runningGmv + value < goalTarget) {
          runningGmv += value;
          selectedAnalytics.push(row);
        }
      }

      const channels = {};
      const orders = {};
      const companies = new Map();
      const accountsMap = new Map();
      for (const row of selectedAnalytics) {
        const empresa = row.empresa || 'Oficial';
        accountsMap.set(empresa, (accountsMap.get(empresa) || 0) + 1);
        if (!row.contabilizado) continue;
        const canal = row.canal || 'A identificar';
        const value = num(row.valor);
        channels[canal] = (channels[canal] || 0) + value;
        orders[canal] = (orders[canal] || 0) + 1;
        const key = `${empresa}\0${canal}`;
        if (!companies.has(key)) {
          companies.set(key, { empresa, canal, gmv: 0, fullGmv: 0, pedidos: 0 });
        }
        const item = companies.get(key);
        item.gmv += value;
        if (row.fulfillment) item.fullGmv += value;
        item.pedidos += 1;
      }

      const financial = typeof summarizeFinancial === 'function'
        ? summarizeFinancial(selectedAnalytics)
        : undefined;

      return {
        ...clean,
        channels,
        orders,
        business: [...companies.values()],
        analytics: selectedAnalytics,
        accounts: [...accountsMap.entries()].map(([empresa, pedidos]) => ({ empresa, pedidos })),
        ...(financial ? { financial } : {})
      };
    }

    const totalGmv = snapshotTotalGmv(clean);
    const maxAllowed = Math.max(0, Math.floor(goalTarget - 1));
    const ratio = totalGmv > 0 ? Math.min(1, maxAllowed / totalGmv) : 0;
    const scaleChannels = source => {
      const scaled = {};
      for (const [canal, value] of Object.entries(source || {})) {
        scaled[canal] = Math.floor(num(value) * ratio);
      }
      let sum = Object.values(scaled).reduce((acc, value) => acc + value, 0);
      if (sum >= goalTarget) {
        const entries = Object.entries(scaled).sort((a, b) => b[1] - a[1]);
        if (entries.length) {
          const [topChannel, topValue] = entries[0];
          const excess = Math.ceil(sum - maxAllowed);
          scaled[topChannel] = Math.max(0, topValue - excess);
        }
      }
      return scaled;
    };

    const scaledChannels = scaleChannels(clean.channels);
    const scaledBusiness = Array.isArray(clean.business)
      ? clean.business.map(row => ({
          ...row,
          gmv: Math.floor(num(row.gmv) * ratio),
          ...(row.fullGmv !== undefined ? { fullGmv: Math.floor(num(row.fullGmv) * ratio) } : {})
        }))
      : [];

    const scaledFinancial = clean.financial && typeof clean.financial === 'object'
      ? {
          ...clean.financial,
          channels: scaleChannels(clean.financial.channels),
          business: Array.isArray(clean.financial.business)
            ? clean.financial.business.map(row => ({
                ...row,
                gmv: Math.floor(num(row.gmv) * ratio),
                ...(row.fullGmv !== undefined ? { fullGmv: Math.floor(num(row.fullGmv) * ratio) } : {})
              }))
            : []
        }
      : undefined;

    return {
      ...clean,
      channels: scaledChannels,
      business: scaledBusiness,
      ...(scaledFinancial ? { financial: scaledFinancial } : {})
    };
  }

  function recordPreGoalSnapshots(daySnapshots, { dataDate, todayDate, target, state } = {}) {
    const goalTarget = num(target);
    if (!isGoalRevealActive(dataDate, todayDate) || !(goalTarget > 0)) {
      return { nextState: null, stateChanged: false };
    }
    const currentState = state && state.dataDate === dataDate
      ? state
      : createEmptyGoalRevealState(dataDate);
    if (currentState.revealed) {
      return { nextState: null, stateChanged: false };
    }
    const sorted = (Array.isArray(daySnapshots) ? daySnapshots : [])
      .filter(s => s && s.dataDate === dataDate)
      .sort((a, b) => new Date(a.at) - new Date(b.at));
    const latest = sorted.at(-1);
    if (!latest || snapshotTotalGmv(latest) >= goalTarget) {
      return { nextState: null, stateChanged: false };
    }
    const sanitized = sanitizePreGoalSnapshots(sorted);
    if (snapshotsSignature(currentState.preGoalSnapshots) === snapshotsSignature(sanitized)) {
      return { nextState: null, stateChanged: false };
    }
    return {
      nextState: {
        ...currentState,
        dataDate,
        preGoalSnapshots: sanitized
      },
      stateChanged: true
    };
  }

  function resolveGoalReveal(allSnapshots, { requestedDate, todayDate, target, state, summarizeFinancial } = {}) {
    const goalTarget = num(target);
    const list = Array.isArray(allSnapshots) ? allSnapshots : [];
    const inactiveReveal = {
      enabled: false,
      date: GOAL_REVEAL_DATE,
      target: goalTarget,
      goalReached: false,
      locked: false,
      revealed: false,
      revealedAt: null,
      canReveal: false
    };

    if (!isGoalRevealActive(requestedDate, todayDate) || !(goalTarget > 0)) {
      return {
        snapshotsForPayload: list,
        goalReveal: inactiveReveal,
        nextState: null,
        stateChanged: false
      };
    }

    const otherDaySnapshots = list.filter(s => s?.dataDate !== requestedDate);
    const daySnapshots = list
      .filter(s => s?.dataDate === requestedDate)
      .sort((a, b) => new Date(a.at) - new Date(b.at));
    const latest = daySnapshots.at(-1) || null;
    const realTotalGmv = latest ? snapshotTotalGmv(latest) : 0;
    const realGoalReached = Boolean(latest && realTotalGmv >= goalTarget);
    const currentState = state && state.dataDate === requestedDate
      ? state
      : createEmptyGoalRevealState(requestedDate);

    if (currentState.revealed) {
      return {
        snapshotsForPayload: list,
        goalReveal: {
          enabled: true,
          date: GOAL_REVEAL_DATE,
          target: goalTarget,
          goalReached: realGoalReached,
          locked: false,
          revealed: true,
          revealedAt: currentState.revealedAt || null,
          canReveal: false
        },
        nextState: null,
        stateChanged: false
      };
    }

    if (!realGoalReached) {
      const recorded = recordPreGoalSnapshots(daySnapshots, {
        dataDate: requestedDate,
        todayDate,
        target: goalTarget,
        state: currentState
      });
      return {
        snapshotsForPayload: list,
        goalReveal: {
          enabled: true,
          date: GOAL_REVEAL_DATE,
          target: goalTarget,
          goalReached: false,
          locked: false,
          revealed: false,
          revealedAt: null,
          canReveal: false
        },
        nextState: recorded.nextState,
        stateChanged: recorded.stateChanged
      };
    }

    const savedPreGoal = Array.isArray(currentState.preGoalSnapshots) ? currentState.preGoalSnapshots : [];
    const hasValidSavedPreGoal = savedPreGoal.length > 0 && snapshotTotalGmv(savedPreGoal.at(-1)) < goalTarget;

    let frozenDaySnapshots;
    let nextState = null;
    let stateChanged = false;

    if (hasValidSavedPreGoal) {
      frozenDaySnapshots = sanitizePreGoalSnapshots(savedPreGoal);
    } else {
      let lastPreGoalIndex = -1;
      for (let i = daySnapshots.length - 1; i >= 0; i--) {
        if (snapshotTotalGmv(daySnapshots[i]) < goalTarget) {
          lastPreGoalIndex = i;
          break;
        }
      }
      if (lastPreGoalIndex >= 0) {
        frozenDaySnapshots = sanitizePreGoalSnapshots(daySnapshots.slice(0, lastPreGoalIndex + 1));
      } else {
        frozenDaySnapshots = [buildSyntheticPreGoalSnapshot(latest, goalTarget, summarizeFinancial)];
      }
      nextState = {
        ...currentState,
        dataDate: requestedDate,
        preGoalSnapshots: frozenDaySnapshots
      };
      stateChanged = true;
    }

    return {
      snapshotsForPayload: [...otherDaySnapshots, ...frozenDaySnapshots],
      goalReveal: {
        enabled: true,
        date: GOAL_REVEAL_DATE,
        target: goalTarget,
        goalReached: true,
        locked: true,
        revealed: false,
        revealedAt: null,
        canReveal: true
      },
      nextState,
      stateChanged
    };
  }

  function canTriggerGoalReveal(allSnapshots, { requestedDate, todayDate, target } = {}) {
    const goalTarget = num(target);
    const active = isGoalRevealActive(requestedDate, todayDate) && goalTarget > 0;
    if (!active) return { active: false, goalReached: false, realTotalGmv: 0 };
    const daySnapshots = (Array.isArray(allSnapshots) ? allSnapshots : [])
      .filter(s => s?.dataDate === requestedDate)
      .sort((a, b) => new Date(a.at) - new Date(b.at));
    const latest = daySnapshots.at(-1) || null;
    const realTotalGmv = latest ? snapshotTotalGmv(latest) : 0;
    return {
      active: true,
      goalReached: Boolean(latest && realTotalGmv >= goalTarget),
      realTotalGmv
    };
  }

  return {
    GOAL_REVEAL_DATE,
    isGoalRevealActive,
    snapshotTotalGmv,
    createEmptyGoalRevealState,
    buildSyntheticPreGoalSnapshot,
    recordPreGoalSnapshots,
    resolveGoalReveal,
    canTriggerGoalReveal
  };
});
