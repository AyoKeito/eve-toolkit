// Self-contained floating table chrome for the LP leaderboard: an aria-hidden
// horizontal scrollbar proxy that tracks the table's overflow, and a pinned
// header clone that appears while the body scrolls under the topbar. Owns its own
// controller state; the app only needs scheduleTableChrome() plus the two
// initialize* entry points. All measurement is coalesced into animation frames.

const $ = (id) => document.getElementById(id);

let floatingScrollbarController = null;
let floatingTableHeaderController = null;

function syncFloatingScrollbar() {
  floatingScrollbarController?.sync();
}

function syncFloatingTableHeader() {
  floatingTableHeaderController?.sync();
}

function requestChromeFrame(callback) {
  if (window.requestAnimationFrame) {
    window.requestAnimationFrame(callback);
  } else {
    window.setTimeout(callback, 0);
  }
}

function createFrameScheduler(callback) {
  let scheduled = false;
  return () => {
    if (scheduled) return;
    scheduled = true;
    requestChromeFrame(() => {
      scheduled = false;
      callback();
    });
  };
}

const scheduleFloatingScrollbar = createFrameScheduler(syncFloatingScrollbar);
const scheduleFloatingTableHeader = createFrameScheduler(syncFloatingTableHeader);

export function scheduleTableChrome() {
  scheduleFloatingScrollbar();
  scheduleFloatingTableHeader();
}

export function initializeFloatingScrollbar() {
  const tableWrap = $("tableWrap");
  const table = tableWrap?.querySelector("table");
  const floatBar = tableWrap?.querySelector(".floating-hscroll");
  const floatInner = floatBar?.querySelector(".floating-hscroll-inner");

  if (!tableWrap || !table || !floatBar || !floatInner) return;

  let tableVisible = false;
  let syncing = false;

  floatBar.setAttribute("aria-hidden", "true");

  function updateScrolledState() {
    tableWrap.classList.toggle("is-scrolled", tableWrap.scrollLeft > 0);
  }

  function syncBounds() {
    const rect = tableWrap.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    const left = `${Math.max(0, rect.left)}px`;
    const right = `${Math.max(0, viewportWidth - rect.right)}px`;
    if (floatBar.style.left !== left) floatBar.style.left = left;
    if (floatBar.style.right !== right) floatBar.style.right = right;
  }

  function syncMetrics() {
    const hasOverflow = table.scrollWidth > tableWrap.clientWidth + 1;
    const innerWidth = `${table.scrollWidth}px`;

    syncBounds();
    if (floatInner.style.width !== innerWidth) floatInner.style.width = innerWidth;
    floatBar.classList.toggle("is-active", tableVisible && hasOverflow);
    if (!syncing) floatBar.scrollLeft = tableWrap.scrollLeft;
    updateScrolledState();
  }

  floatingScrollbarController = { sync: syncMetrics };

  tableWrap.addEventListener("scroll", () => {
    if (syncing) return;
    syncing = true;
    floatBar.scrollLeft = tableWrap.scrollLeft;
    syncing = false;
    tableWrap.classList.toggle("is-scrolled", tableWrap.scrollLeft > 0);
  }, { passive: true });

  floatBar.addEventListener("scroll", () => {
    if (syncing) return;
    syncing = true;
    tableWrap.scrollLeft = floatBar.scrollLeft;
    syncing = false;
    updateScrolledState();
  }, { passive: true });

  if ("ResizeObserver" in window) {
    const resizeObserver = new ResizeObserver(() => scheduleFloatingScrollbar());
    resizeObserver.observe(table);
    resizeObserver.observe(tableWrap);
  } else {
    window.addEventListener("resize", scheduleFloatingScrollbar);
  }

  if ("IntersectionObserver" in window) {
    const intersectionObserver = new IntersectionObserver((entries) => {
      tableVisible = entries.some((entry) => entry.isIntersecting);
      scheduleFloatingScrollbar();
    });
    intersectionObserver.observe(tableWrap);
  } else {
    tableVisible = true;
  }

  syncFloatingScrollbar();
}

export function initializeFloatingTableHeader() {
  const tableWrap = $("tableWrap");
  const table = tableWrap?.querySelector("table");
  const sourceHead = table?.querySelector("thead");
  const topbar = document.querySelector(".topbar");
  const clonedHead = table?.querySelector("thead")?.cloneNode(true);

  if (!tableWrap || !table || !sourceHead || !clonedHead) return;

  const floatingHeader = document.createElement("div");
  floatingHeader.className = "floating-table-header";
  floatingHeader.setAttribute("aria-hidden", "true");

  const floatingTable = document.createElement("table");
  floatingTable.append(clonedHead);
  floatingHeader.append(floatingTable);
  document.body.append(floatingHeader);

  for (const button of floatingHeader.querySelectorAll("button")) {
    button.tabIndex = -1;
  }

  const mobileMedia = window.matchMedia("(max-width: 700px)");
  let floatingHeaderActive = false;
  const sourceCells = [...sourceHead.querySelectorAll("th")];
  const cloneCells = [...clonedHead.querySelectorAll("th")];
  const clonedColumnWidths = [];

  function setFloatingHeaderActive(active) {
    if (floatingHeaderActive === active) return;
    floatingHeaderActive = active;
    floatingHeader.classList.toggle("is-active", active);
  }

  function syncFloatingHeaderColumnWidths() {
    sourceCells.forEach((sourceCell, index) => {
      const cloneCell = cloneCells[index];
      if (!cloneCell) return;
      const measuredWidth = sourceCells[index].getBoundingClientRect().width;
      if (!Number.isFinite(measuredWidth) || measuredWidth <= 0) return;
      const width = `${measuredWidth}px`;
      if (clonedColumnWidths[index] === width) return;
      clonedColumnWidths[index] = width;
      cloneCells[index].style.width = width;
      cloneCell.style.minWidth = width;
      cloneCell.style.maxWidth = width;
    });
  }

  function syncMetrics() {
    const wrapRect = tableWrap.getBoundingClientRect();
    const topbarBottom = topbar?.getBoundingClientRect().bottom ?? 0;
    if (mobileMedia.matches || wrapRect.top >= topbarBottom || wrapRect.bottom <= topbarBottom) {
      setFloatingHeaderActive(false);
      return;
    }

    const headRect = sourceHead.getBoundingClientRect();
    const headerHeight = headRect.height || floatingHeader.offsetHeight || 0;
    const isPinned = wrapRect.top < topbarBottom && wrapRect.bottom > topbarBottom + headerHeight;
    if (!isPinned) {
      setFloatingHeaderActive(false);
      return;
    }

    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    const top = `${Math.max(0, topbarBottom)}px`;
    const left = `${Math.max(0, wrapRect.left)}px`;
    const right = `${Math.max(0, viewportWidth - wrapRect.right)}px`;
    const tableWidth = `${table.scrollWidth}px`;
    if (floatingHeader.style.top !== top) floatingHeader.style.top = top;
    if (floatingHeader.style.left !== left) floatingHeader.style.left = left;
    if (floatingHeader.style.right !== right) floatingHeader.style.right = right;
    if (floatingTable.style.width !== tableWidth) floatingTable.style.width = tableWidth;
    floatingHeader.scrollLeft = tableWrap.scrollLeft;
    syncFloatingHeaderColumnWidths();
    setFloatingHeaderActive(true);
  }

  floatingTableHeaderController = { sync: syncMetrics };

  tableWrap.addEventListener("scroll", scheduleFloatingTableHeader, { passive: true });
  window.addEventListener("scroll", scheduleFloatingTableHeader, { passive: true });
  window.addEventListener("resize", scheduleFloatingTableHeader);

  if (mobileMedia.addEventListener) {
    mobileMedia.addEventListener("change", scheduleFloatingTableHeader);
  } else {
    mobileMedia.addListener?.(scheduleFloatingTableHeader);
  }

  if ("ResizeObserver" in window) {
    const resizeObserver = new ResizeObserver(() => scheduleFloatingTableHeader());
    resizeObserver.observe(table);
    resizeObserver.observe(tableWrap);
    resizeObserver.observe(sourceHead);
    if (topbar) resizeObserver.observe(topbar);
  }

  syncFloatingTableHeader();
}
