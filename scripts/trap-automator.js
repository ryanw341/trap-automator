/*
 * Trap Automator
 *
 * This script implements the full workflow for creating traps and caches in
 * Foundry VTT. When a GM presses Shift+T the module presents a series of
 * dialogs allowing the GM to choose a trap or cache type, select a location
 * and trigger, define save and damage parameters (for traps) or a custom
 * description (for caches), then instructs the GM to draw a tile on the
 * scene. Once the tile is drawn the module attaches the assembled trap
 * data as a flag on the tile and spawns four hint tokens around it. Hint
 * tokens are pulled from existing actors named "Hint +2", "Hint +4",
 * "Hint +6" and "Hint +10" and are positioned above, to the right,
 * below and to the left of the tile.
 *
 * The trap and cache definitions are loaded from a JSON file packaged with
 * the module and may be extended via a world setting. The flavour text for
 * traps is normalised to the pattern "You <trigger> <location phrase>.
 * <description>" so that all traps read consistently. Saving throw DCs are
 * hidden from the player.
 */

class TrapAutomator {
  constructor() {
    // Live state for the current creation workflow.
    this.currentData = {};
    // Definitions will be populated from JSON on ready. They are keyed
    // separately for traps and caches and include descriptions, default
    // saves and hint strings.
    this.definitions = { trap: {}, cache: {}, triggers: {} };
  }

  /**
   * Register the Shift+T keybinding to open the creation workflow. Only
   * GMs may trigger this workflow. Logs to the console when the binding
   * registers and when the key is pressed.
   */
  registerKeybinding() {
    console.log('Trap Automator: registering keybinding');
    game.keybindings.register('trap-automator', 'open-trap-menu', {
      name: 'Open Trap/Cache Automator',
      hint: 'Open the trap or cache creation menu.',
      editable: [
        {
          key: 'KeyT',
          modifiers: ['Shift']
        }
      ],
      restricted: true,
      onDown: () => {
        console.log('Trap Automator: hot‑key pressed');
        if (!game.user.isGM) {
          ui.notifications.warn('Only the GM can create traps or caches.');
          return false;
        }
        this.openInitialDialog();
        return true;
      },
      onUp: () => {}
    });
  }

  /**
   * Register a world‑scoped setting to persist custom definitions. This is called
   * during the init hook before any data is loaded. The stored object will
   * mirror the structure of the builtin definitions and can contain
   * categories, triggers, traps and caches. Updates to this setting will
   * survive server restarts.
   */
  static registerSettings() {
    game.settings.register('trap-automator', 'customDefs', {
      name: 'Custom Trap Automator Definitions',
      scope: 'world',
      config: false,
      type: Object,
      default: {}
    });

    // Register a setting to persist the macro UUID used when triggering
    // traps or caches. When a GM selects a different macro via the
    // "Select Macro" menu this value will be updated. The default is
    // the provided macro id used in earlier versions of the module.
    game.settings.register('trap-automator', 'macroId', {
      name: 'Trap Automator Macro ID',
      scope: 'world',
      config: false,
      type: String,
      default: 'Macro.z9RXNw9fEKBIkxHW'
    });
  }

  /**
   * Merge custom definitions into the existing definitions. Performs a deep
   * merge so that individual traps or caches may be overridden or added
   * without replacing the entire definitions object.
   * @param {Object} defs Custom definitions to merge
   */
  mergeDefinitions(defs) {
    const merge = (target, source) => {
      for (const [key, value] of Object.entries(source)) {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          if (!target[key]) target[key] = {};
          merge(target[key], value);
        } else {
          target[key] = value;
        }
      }
    };
    merge(this.definitions, defs);
  }

  /**
   * Initialise default trigger lists for each primary category. This method
   * populates the definitions.triggers object with sensible phrases that
   * fit into the flavour pattern "You <trigger> <location>". If custom
   * triggers already exist for a category they are left untouched. For
   * subcategories defined in customDefs.categories with a primary
   * reference, triggers from the parent category are copied over so
   * subcategories share their parent's trigger list.
   */
  initializeDefaultTriggers() {
    // Define default triggers per primary category
    const defaults = {
      'generic': [
        'step on a pressure plate',
        'bump into a tripwire',
        'pull a hidden lever',
        'open a trapped chest',
        'turn the wrong doorknob',
        'push a false door'
      ],
      'sci-fi': [
        'trigger a motion sensor',
        'trigger a biometric scanner',
        'break a laser tripwire',
        'activate an infrared sensor',
        'trigger a proximity alarm',
        'walk through a force field'
      ],
      'magical': [
        'disturb a runic sigil',
        'trigger a magical ward',
        'activate a glyph of warding',
        'break an arcane seal',
        'speak a forbidden phrase',
        'touch a cursed idol'
      ],
      'natural': [
        'trip a snare',
        'step on a loose root',
        'brush against a vine',
        'set off a hidden pit',
        'disturb a beehive',
        'disturb a nest'
      ],
      'grimdark': [
        'step on a landmine',
        'break a tripwire of skulls',
        'activate a proximity scanner',
        'breach a security field',
        'disturb a servo-skull',
        'open a forbidden vault'
      ]
    };
    if (!this.definitions.triggers || typeof this.definitions.triggers !== 'object') {
      this.definitions.triggers = {};
    }
    // Assign defaults if no triggers defined for a category
    for (const cat of Object.keys(defaults)) {
      const existing = this.definitions.triggers[cat];
      if (!existing || !Array.isArray(existing) || existing.length === 0) {
        this.definitions.triggers[cat] = defaults[cat].slice();
      }
    }
    // Copy triggers for subcategories from their primary parent
    try {
      const custom = game.settings.get('trap-automator', 'customDefs') || {};
      const cats = custom.categories || {};
      for (const [sub, info] of Object.entries(cats)) {
        if (!info || !info.primary) continue;
        const primary = info.primary;
        // If triggers defined for subcategory are missing or empty, copy from primary
        if (!this.definitions.triggers[sub] || !Array.isArray(this.definitions.triggers[sub]) || this.definitions.triggers[sub].length === 0) {
          const parentList = this.definitions.triggers[primary];
          if (Array.isArray(parentList)) {
            this.definitions.triggers[sub] = parentList.slice();
          }
        }
      }
    } catch (err) {
      // ignore
    }

    // Also ensure built‑in subcategories inherit triggers from their primary category. Iterate through
    // existing trap definitions to detect categories and assign triggers accordingly.
    try {
      const trapDefs = this.definitions.trap || {};
      for (const def of Object.values(trapDefs)) {
        const cat = def.category;
        if (!cat) continue;
        const { primary, sub } = this.categorizeCategory(cat);
        // If this is a subcategory (sub not null) and triggers for it are missing, copy from primary
        if (sub && (!this.definitions.triggers[sub] || this.definitions.triggers[sub].length === 0)) {
          const list = this.definitions.triggers[primary];
          if (Array.isArray(list)) {
            this.definitions.triggers[sub] = list.slice();
          }
        }
      }
    } catch (err) {
      // ignore
    }
  }

  /**
   * Present the initial dialog asking the GM to choose whether to create a
   * trap or a cache. This also offers stub options for adding or editing
   * definitions which currently show a notification indicating the
   * functionality is unimplemented.
   */
  openInitialDialog() {
    this.currentData = {};
    new Dialog({
      title: 'Trap Automator',
      content: '<p>What would you like to create?</p>',
      buttons: {
        trap: {
          label: 'Trap',
          callback: () => {
            this.currentData.type = 'trap';
            this.openTrapTypeDialog();
          }
        },
        cache: {
          label: 'Cache',
          callback: () => {
            this.currentData.type = 'cache';
            this.openCacheTypeDialog();
          }
        },
        addDef: {
          label: 'Add Definition',
          callback: () => {
            this.openAddDefinitionDialog();
          }
        },
        editDef: {
          label: 'Edit Definitions',
          callback: () => {
            this.openEditDefinitionDialog();
          }
        },
        selectMacro: {
          label: 'Select Macro',
          callback: () => {
            this.openSelectMacroDialog();
          }
        },
        cancel: {
          label: 'Cancel'
        }
      },
      default: 'trap'
    }).render(true);
  }

  /**
   * Present a dialog prompting the GM to choose which type of definition to add.
   * Options include Category, Trigger, Cache and Trap. Upon selection the
   * workflow proceeds to further dialogs to collect the necessary fields.
   */
  openAddDefinitionDialog() {
    const content = '<p>What kind of definition would you like to add?</p>';
    new Dialog({
      title: 'Add Definition',
      content,
      buttons: {
        category: {
          label: 'Category',
          callback: () => this.openAddCategoryDialog()
        },
        trigger: {
          label: 'Trigger',
          callback: () => this.openAddTriggerDialog()
        },
        cache: {
          label: 'Cache',
          callback: () => this.openAddCacheDialog()
        },
        trap: {
          label: 'Trap',
          callback: () => this.openAddTrapDialog()
        },
        subcat: {
          label: 'Subcategory',
          callback: () => this.openAddSubcategoryDialog()
        },
        cancel: {
          label: 'Cancel'
        }
      },
      default: 'category'
    }).render(true);
  }

  /**
   * Present a dialog to choose what type of definition to edit. Once a type
   * is selected further dialogs will prompt for category and specific
   * definition selection if necessary.
   */
  openEditDefinitionDialog() {
    const content = '<p>What kind of definition would you like to edit?</p>';
    new Dialog({
      title: 'Edit Definition',
      content,
      buttons: {
        category: {
          label: 'Category',
          callback: () => this.openEditCategoryDialog()
        },
        trigger: {
          label: 'Trigger',
          callback: () => this.openEditTriggerDialog()
        },
        cache: {
          label: 'Cache',
          callback: () => this.openEditCacheDialog()
        },
        trap: {
          label: 'Trap',
          callback: () => this.openEditTrapDialog()
        },
        cancel: {
          label: 'Cancel'
        }
      },
      default: 'category'
    }).render(true);
  }

  /**
   * Compute a list of all unique categories defined in builtin and custom
   * definitions. Used for populating drop‑downs when adding or editing
   * definitions.
   * @returns {Array<string>} Sorted list of category identifiers
   */
  getAllCategories() {
    const cats = new Set();
    // Gather builtin categories
    for (const type of ['trap', 'cache']) {
      const defs = this.definitions[type] || {};
      for (const key of Object.keys(defs)) {
        const c = defs[key].category;
        if (c) cats.add(c);
      }
    }
    // Gather custom categories from settings
    try {
      const custom = game.settings.get('trap-automator', 'customDefs') || {};
      if (custom.categories) {
        for (const key of Object.keys(custom.categories)) cats.add(key);
      }
    } catch (err) {}
    return Array.from(cats).sort();
  }

  /**
   * Determine the primary category and optional subcategory for a given
   * category name. Custom categories (added via Add Subcategory) specify
   * their primary category via the stored custom definition. Built‑in
   * categories are mapped according to heuristics.
   * @param {string} catName The final category name
   * @returns {Object} { primary: string, sub: string|null }
   */
  categorizeCategory(catName) {
    const name = String(catName || '').toLowerCase();
    // Check custom categories for primary assignment. If the category exists
    // in custom definitions and specifies a primary, treat it as a subcategory.
    // Otherwise if the category exists in custom definitions but has no
    // primary specified, treat the category itself as a primary category.
    try {
      const custom = game.settings.get('trap-automator', 'customDefs') || {};
      if (custom.categories && custom.categories[name]) {
        const info = custom.categories[name];
        if (info && info.primary) {
          return { primary: info.primary, sub: name };
        }
        // Custom category without a primary -> primary is itself
        return { primary: name, sub: null };
      }
    } catch (err) {}
    // Built‑in mapping
    const grimdarkSubs = [
      'imperial', 'ork', 'eldar', 'necron', 'tau', 'chaos', 'daemon', 'sisters', 'adeptus', 'tyranid', 'harlequin', 'dark-eldar', 'dark eldar'
    ];
    if (grimdarkSubs.includes(name)) return { primary: 'grimdark', sub: name };
    if (/sci[- ]?fi/.test(name)) return { primary: 'sci-fi', sub: null };
    if (/magic|magical|arcane/.test(name)) return { primary: 'magical', sub: null };
    if (/natural|nature/.test(name)) return { primary: 'natural', sub: null };
    return { primary: 'generic', sub: null };
  }

  /**
   * Retrieve a list of subcategories for a given primary category. This
   * includes built‑in categories that map to the primary as well as custom
   * categories that declare the same primary.
   * @param {string} primary The primary category
   * @returns {Array<string>} Sorted list of subcategory identifiers
   */
  getSubcategories(primary) {
    const subs = new Set();
    // Built‑in definitions
    for (const type of ['trap', 'cache']) {
      const defs = this.definitions[type] || {};
      for (const key of Object.keys(defs)) {
        const cat = defs[key].category || '';
        const { primary: p, sub } = this.categorizeCategory(cat);
        if (p === primary && sub) subs.add(sub);
      }
    }
    // Custom categories
    try {
      const custom = game.settings.get('trap-automator', 'customDefs') || {};
      const cats = custom.categories || {};
      for (const [k, v] of Object.entries(cats)) {
        if (v.primary === primary) subs.add(k);
      }
    } catch (err) {}
    return Array.from(subs).sort();
  }

  /**
   * Clean a trap description's flavour text by removing references to the
   * trigger or location placeholders. Built‑in definitions often include
   * strings such as "You {trigger}{location} and …" or "As you trigger
   * {trigger}, …" which would duplicate the trigger and location when the
   * narrative is composed. This helper strips those patterns and any
   * leftover placeholder tokens, normalises whitespace and capitalises the
   * resulting description. It also removes simple prepositions (in/on/from
   * the) that become orphaned once the location placeholder is removed.
   * @param {string} flavor The raw flavour string from a definition
   * @returns {string} A cleaned description with no placeholder markers
   */
  cleanFlavorText(flavor) {
    if (!flavor || typeof flavor !== 'string') return '';
    let s = flavor.trim();
    // Remove leading clauses such as "As you trigger {trigger}," or
    // "As you {trigger}," that describe the trigger action. These
    // introductory phrases vary in wording, so use a few regex patterns.
    s = s.replace(/^As you trigger \{trigger\},\s*/i, '');
    s = s.replace(/^As you \{trigger\},\s*/i, '');
    s = s.replace(/^As you [^,]*?,\s*/i, '');
    s = s.replace(/^When you trigger \{trigger\},\s*/i, '');
    s = s.replace(/^When \{trigger\}[^,]*?,\s*/i, '');
    // Remove patterns like "You {trigger}{location} and …" or "You {trigger}
    // and …" which would duplicate the trigger text.
    s = s.replace(/^You\s*\{trigger\}\s*\{location\}\s*and\s*/i, '');
    s = s.replace(/^You\s*\{trigger\}\s*and\s*/i, '');
    s = s.replace(/^You\s*\{trigger\}\s*\{location\}\s*/i, '');
    // Remove remaining placeholder markers
    s = s.replace(/\{trigger\}/gi, '').replace(/\{location\}/gi, '');
    // Remove orphaned prepositional phrases that refer to the location
    // e.g. "in the " or "on the " that remain after {location} removal.
    s = s.replace(/\s+(in|on|from)\s+the\s*,?/gi, ' ');
    // Compress consecutive whitespace to a single space
    s = s.replace(/\s+/g, ' ');
    // Remove leading "You " if still present
    if (/^You\s+/i.test(s)) s = s.replace(/^You\s+/i, '');
    // Trim any leading/trailing punctuation and whitespace
    s = s.trim().replace(/^[,\.\s]+/, '').replace(/[\s,]+$/, '');
    // Capitalise first letter for readability
    if (s.length > 0) {
      s = s.charAt(0).toUpperCase() + s.slice(1);
    }
    return s;
  }

  /**
   * Return the list of final categories (including subcategories) that can
   * have separate triggers. This collects category names from trap
   * definitions and custom categories.
   * @returns {Array<string>} Sorted list of final category keys
   */
  getTriggerCategoryKeys() {
    const cats = new Set();
    for (const key of Object.keys(this.definitions.trap || {})) {
      const cat = this.definitions.trap[key].category;
      if (cat) cats.add(cat);
    }
    // Include custom category keys
    try {
      const custom = game.settings.get('trap-automator', 'customDefs') || {};
      if (custom.categories) {
        for (const key of Object.keys(custom.categories)) cats.add(key);
      }
    } catch (err) {}
    return Array.from(cats).sort();
  }

  /**
   * Convert an arbitrary string into a slug suitable for use as an object key.
   * Lowercases, trims whitespace and replaces non‑alphanumeric characters
   * with hyphens.
   * @param {string} str Input string
   * @returns {string} Slugified string
   */
  slugify(str) {
    return String(str || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      || 'new-item';
  }

  /**
   * Persist the provided custom definitions object to the world settings and
   * immediately merge it into the live definitions so subsequent dialogs
   * reflect the changes.
   * @param {Object} custom Updated custom definitions object
   */
  async saveCustomDefinitions(custom) {
    await game.settings.set('trap-automator', 'customDefs', custom);
    // Merge into live definitions
    this.mergeDefinitions(custom);
  }

  /**
   * Dialog for adding a new category. Only requires a category identifier.
   */
  openAddCategoryDialog() {
    const content = `<form><div class="form-group"><label for="ta-add-cat-id">New category ID:</label><input type="text" id="ta-add-cat-id" name="ta-add-cat-id" /></div></form>`;
    new Dialog({
      title: 'Add Category',
      content,
      buttons: {
        create: {
          label: 'Create',
          callback: async html => {
            const cat = this.slugify(html.find('#ta-add-cat-id').val());
            if (!cat) {
              ui.notifications.warn('Category ID cannot be empty.');
              return;
            }
            const custom = duplicate(game.settings.get('trap-automator', 'customDefs') || {});
            if (!custom.categories) custom.categories = {};
            if (custom.categories[cat]) {
              ui.notifications.warn('Category already exists in custom definitions.');
              return;
            }
            custom.categories[cat] = { name: cat };
            await this.saveCustomDefinitions(custom);
            ui.notifications.info(`Category "${cat}" added.`);
          }
        },
        cancel: { label: 'Cancel' }
      },
      default: 'create'
    }).render(true);
  }

  /**
   * Dialog for adding a trigger. Select the category the trigger belongs to and
   * enter the trigger text. If no category is selected the trigger will be
   * added to the global list ("all").
   */
  openAddTriggerDialog() {
    // Allow triggers to be added to any primary category. Build the list of
    // available categories from current definitions and custom definitions.
    let categories = [];
    try {
      categories = this.getTriggerCategoryKeys();
    } catch (err) {
      categories = [];
    }
    // Derive primary categories by checking for subcategories. Only categories
    // whose categorizeCategory result has no sub are considered primary.
    const primarySet = new Set();
    for (const cat of categories) {
      const { primary, sub } = this.categorizeCategory(cat);
      if (!sub) primarySet.add(primary);
    }
    let primaryCats = Array.from(primarySet).sort();
    // If no categories exist yet, provide a default list of primary categories
    // so that the user has some choices to start with.
    if (!primaryCats.length) {
      primaryCats = ['generic', 'sci-fi', 'magical', 'natural', 'grimdark'];
    }
    const options = primaryCats
      .map(c => `<option value="${c}">${c.charAt(0).toUpperCase() + c.slice(1)}</option>`)
      .join('');
    const content = `<form>
      <div class="form-group">
        <label for="ta-add-trig-cat">Category:</label>
        <select id="ta-add-trig-cat" name="ta-add-trig-cat">
          ${options}
        </select>
      </div>
      <div class="form-group">
        <label for="ta-add-trig-text">Trigger description:</label>
        <input type="text" id="ta-add-trig-text" name="ta-add-trig-text" />
      </div>
    </form>`;
    new Dialog({
      title: 'Add Trigger',
      content,
      buttons: {
        create: {
          label: 'Add',
          callback: async html => {
            const cat = html.find('#ta-add-trig-cat').val();
            const trig = html.find('#ta-add-trig-text').val().trim();
            if (!trig) {
              ui.notifications.warn('Trigger text cannot be empty.');
              return;
            }
            const custom = duplicate(game.settings.get('trap-automator', 'customDefs') || {});
            if (!custom.triggers) custom.triggers = {};
            if (!custom.triggers[cat]) custom.triggers[cat] = [];
            custom.triggers[cat].push(trig);
            await this.saveCustomDefinitions(custom);
            ui.notifications.info(`Trigger added under category "${cat}".`);
          }
        },
        cancel: { label: 'Cancel' }
      },
      default: 'create'
    }).render(true);
  }

  /**
   * Dialog for adding a cache. Prompts for category, cache name, description
   * and one or more sets of hints. The four difficulty levels (+2, +4, +6
   * and +10) are entered for each set. Additional sets may be added by
   * clicking the Add Set button.
   */
  openAddCacheDialog() {
    // Build primary categories dynamically. Use custom categories if any exist;
    // otherwise fall back to default primaries.
    let allCats = [];
    try {
      allCats = this.getAllCategories();
    } catch (err) {
      allCats = [];
    }
    const primarySet = new Set();
    for (const cat of allCats) {
      const { primary, sub } = this.categorizeCategory(cat);
      if (!sub) primarySet.add(primary);
    }
    let primaryCats = Array.from(primarySet).sort();
    if (!primaryCats.length) {
      primaryCats = ['generic', 'sci-fi', 'magical', 'natural', 'grimdark'];
    }
    const options = primaryCats.map(c => `<option value="${c}">${c.charAt(0).toUpperCase() + c.slice(1)}</option>`).join('');
    const content = `<form id="ta-add-cache-form">
      <div class="form-group">
        <label for="ta-add-cache-cat">Category:</label>
        <select id="ta-add-cache-cat" name="ta-add-cache-cat">
          ${options}
        </select>
      </div>
      <div class="form-group">
        <label for="ta-add-cache-name">Name:</label>
        <input type="text" id="ta-add-cache-name" name="ta-add-cache-name" />
      </div>
      <div class="form-group">
        <label for="ta-add-cache-desc">Description:</label>
        <textarea id="ta-add-cache-desc" name="ta-add-cache-desc" rows="3"></textarea>
      </div>
      <hr/>
      <h3>Hint Sets</h3>
      <div id="ta-cache-sets">
        ${this._renderHintSet(0)}
      </div>
      <button type="button" id="ta-add-cache-addset">Add Another Set</button>
    </form>`;
    const dlg = new Dialog({
      title: 'Add Cache',
      content,
      buttons: {
        create: {
          label: 'Create',
          callback: async html => {
            const cat = html.find('#ta-add-cache-cat').val();
            const name = html.find('#ta-add-cache-name').val().trim();
            const desc = html.find('#ta-add-cache-desc').val().trim();
            if (!name) {
              ui.notifications.warn('Cache name cannot be empty.');
              return;
            }
            // Build hint sets
            const sets = [];
            html.find('.ta-hint-set').each((idx, el) => {
              const $el = $(el);
              const i = $el.data('idx');
              const set = {
                '+2': $el.find(`[name="hint-${i}-2"]`).val().trim(),
                '+4': $el.find(`[name="hint-${i}-4"]`).val().trim(),
                '+6': $el.find(`[name="hint-${i}-6"]`).val().trim(),
                '+10': $el.find(`[name="hint-${i}-10"]`).val().trim()
              };
              sets.push(set);
            });
            if (!sets.length || !sets[0]['+2']) {
              ui.notifications.warn('At least one hint set must be filled in.');
              return;
            }
            const custom = duplicate(game.settings.get('trap-automator', 'customDefs') || {});
            if (!custom.cache) custom.cache = {};
            const key = this.slugify(name);
            custom.cache[key] = {
              name,
              category: cat,
              description: { found: desc },
              hints: {
                floor: sets,
                wall: sets,
                ceiling: sets,
                other: sets
              }
            };
            await this.saveCustomDefinitions(custom);
            ui.notifications.info(`Cache "${name}" added.`);
          }
        },
        cancel: { label: 'Cancel' }
      },
      default: 'create'
    });
    dlg.render(true);
    // Attach handler for adding hint sets, ensuring old handlers are removed
    $(document).off('click.taAddCache');
    $(document).on('click.taAddCache', '#ta-add-cache-addset', ev => {
      ev.preventDefault();
      const container = $('#ta-cache-sets');
      const idx = container.children('.ta-hint-set').length;
      container.append(this._renderHintSet(idx));
    });
  }

  /**
   * Internal helper to render a hint set. Accepts an index and returns an
   * HTML string with inputs named using that index. Adds the class
   * "ta-hint-set" and data-idx attribute for later retrieval.
   * @param {number} idx Index of the hint set
   * @returns {string} HTML for hint set
   */
  _renderHintSet(idx) {
    return `<div class="ta-hint-set" data-idx="${idx}" style="margin-bottom:1em;border:1px solid #666;padding:0.5em;">
      <strong>Set ${idx + 1}</strong><br/>
      <label>+2:</label> <input type="text" name="hint-${idx}-2" /><br/>
      <label>+4:</label> <input type="text" name="hint-${idx}-4" /><br/>
      <label>+6:</label> <input type="text" name="hint-${idx}-6" /><br/>
      <label>+10:</label> <input type="text" name="hint-${idx}-10" /><br/>
    </div>`;
  }

  /**
   * Dialog for adding a trap. Prompts for category, trap name, save ability,
   * flavour description, failure text, success text and one or more hint
   * sets. Additional sets may be added via the Add Set button.
   */
  openAddTrapDialog() {
    // Build primary category list dynamically from existing categories. We gather
    // all categories defined in built‑in and custom definitions, then derive
    // primary categories using categorizeCategory. Categories with no sub
    // designation are treated as primary. If none exist, fall back to
    // default primaries so the user can still create traps.
    let allCats = [];
    try {
      allCats = this.getAllCategories();
    } catch (err) {
      allCats = [];
    }
    const primarySet = new Set();
    for (const cat of allCats) {
      const { primary, sub } = this.categorizeCategory(cat);
      if (!sub) primarySet.add(primary);
    }
    let primaryCats = Array.from(primarySet).sort();
    if (!primaryCats.length) {
      primaryCats = ['generic', 'sci-fi', 'magical', 'natural', 'grimdark'];
    }
    const options = primaryCats.map(c => `<option value="${c}">${c.charAt(0).toUpperCase() + c.slice(1)}</option>`).join('');
    // Precompute subcategories for each primary category using helper
    const subsByPrimary = {};
    for (const pc of primaryCats) {
      subsByPrimary[pc] = this.getSubcategories(pc);
    }
    const initialSubs = subsByPrimary[primaryCats[0]] || [];
    const subOptions = initialSubs.map(s => `<option value="${s}">${s.charAt(0).toUpperCase() + s.slice(1)}</option>`).join('');
    const saveTypes = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
    const saveOpts = saveTypes.map(s => `<option value="${s}">${s.toUpperCase()}</option>`).join('');
    const content = `<form id="ta-add-trap-form">
      <div class="form-group">
        <label for="ta-add-trap-cat">Category:</label>
        <select id="ta-add-trap-cat" name="ta-add-trap-cat">
          ${options}
        </select>
      </div>
      <div class="form-group" id="ta-add-trap-subcat-wrap" style="display:none;">
        <label for="ta-add-trap-subcat">Sub-category:</label>
        <select id="ta-add-trap-subcat" name="ta-add-trap-subcat">
          ${subOptions}
        </select>
      </div>
      <div class="form-group">
        <label for="ta-add-trap-name">Name:</label>
        <input type="text" id="ta-add-trap-name" name="ta-add-trap-name" />
      </div>
      <div class="form-group">
        <label for="ta-add-trap-save">Default Save Ability:</label>
        <select id="ta-add-trap-save" name="ta-add-trap-save">
          ${saveOpts}
        </select>
      </div>
      <div class="form-group">
        <label for="ta-add-trap-desc">Trap Description:</label>
        <textarea id="ta-add-trap-desc" name="ta-add-trap-desc" rows="2"></textarea>
      </div>
      <div class="form-group">
        <label for="ta-add-trap-fail">Failure Text:</label>
        <input type="text" id="ta-add-trap-fail" name="ta-add-trap-fail" />
      </div>
      <div class="form-group">
        <label for="ta-add-trap-success">Success Text:</label>
        <input type="text" id="ta-add-trap-success" name="ta-add-trap-success" />
      </div>
      <hr/>
      <h3>Hint Sets</h3>
      <div id="ta-trap-sets">
        ${this._renderHintSet(0)}
      </div>
      <button type="button" id="ta-add-trap-addset">Add Another Set</button>
    </form>`;
    const dlg = new Dialog({
      title: 'Add Trap',
      content,
      buttons: {
        create: {
          label: 'Create',
          callback: async html => {
            let catVal = html.find('#ta-add-trap-cat').val();
            // If the category has a visible subcategory selector, use it as final category
            const subWrap = html.find('#ta-add-trap-subcat-wrap');
            const subSel = html.find('#ta-add-trap-subcat');
            if (subWrap.is(':visible')) {
              if (!subSel.length || !subSel.val()) {
                ui.notifications.warn('Please select a sub-category.');
                return;
              }
              catVal = subSel.val();
            }
            const name = html.find('#ta-add-trap-name').val().trim();
            const save = html.find('#ta-add-trap-save').val();
            const desc = html.find('#ta-add-trap-desc').val().trim();
            const failText = html.find('#ta-add-trap-fail').val().trim();
            const successText = html.find('#ta-add-trap-success').val().trim();
            if (!name || !desc) {
              ui.notifications.warn('Trap name and description are required.');
              return;
            }
            // Build hint sets
            const sets = [];
            html.find('.ta-hint-set').each((idx, el) => {
              const $el = $(el);
              const i = $el.data('idx');
              const set = {
                '+2': $el.find(`[name="hint-${i}-2"]`).val().trim(),
                '+4': $el.find(`[name="hint-${i}-4"]`).val().trim(),
                '+6': $el.find(`[name="hint-${i}-6"]`).val().trim(),
                '+10': $el.find(`[name="hint-${i}-10"]`).val().trim()
              };
              sets.push(set);
            });
            if (!sets.length || !sets[0]['+2'] || !sets[0]['+4'] || !sets[0]['+6'] || !sets[0]['+10']) {
              ui.notifications.warn('At least one complete hint set must be provided.');
              return;
            }
            const custom = duplicate(game.settings.get('trap-automator', 'customDefs') || {});
            if (!custom.trap) custom.trap = {};
            const key = this.slugify(name);
            custom.trap[key] = {
              name,
              category: catVal,
              defaultSave: save,
              defaultDC: 10,
              description: {
                flavor: desc,
                fail: failText,
                success: successText
              },
              hints: {
                floor: sets,
                wall: sets,
                ceiling: sets,
                other: sets
              }
            };
            await this.saveCustomDefinitions(custom);
            ui.notifications.info(`Trap "${name}" added.`);
          }
        },
        cancel: { label: 'Cancel' }
      },
      default: 'create'
    });
    dlg.render(true);
    // Attach handlers for adding hint sets and updating subcategory options
    $(document).off('click.taAddTrap');
    $(document).on('click.taAddTrap', '#ta-add-trap-addset', ev => {
      ev.preventDefault();
      const container = $('#ta-trap-sets');
      const idx = container.children('.ta-hint-set').length;
      container.append(this._renderHintSet(idx));
    });
    $(document).off('change.taAddTrapCat');
    $(document).on('change.taAddTrapCat', '#ta-add-trap-cat', ev => {
      const val = ev.target.value;
      const wrap = $('#ta-add-trap-subcat-wrap');
      const select = $('#ta-add-trap-subcat');
      const subs = subsByPrimary[val] || [];
      if (subs.length) {
        select.empty();
        for (const s of subs) {
          const opt = document.createElement('option');
          opt.value = s;
          opt.textContent = s.charAt(0).toUpperCase() + s.slice(1);
          select.append(opt);
        }
        wrap.show();
      } else {
        wrap.hide();
      }
    });
  }

  /**
   * Dialog for adding a new subcategory. Prompts for a primary category
   * from a fixed list (generic, sci-fi, magical, natural, grimdark) and
   * a new subcategory identifier. The new subcategory is stored in
   * custom definitions with a `primary` property referring to the
   * selected primary. Only non-empty, unique slugs are allowed.
   */
  openAddSubcategoryDialog() {
    // Determine primary categories dynamically from existing definitions
    let allCats = [];
    try {
      allCats = this.getAllCategories();
    } catch (err) {
      allCats = [];
    }
    const primarySet = new Set();
    for (const cat of allCats) {
      const { primary, sub } = this.categorizeCategory(cat);
      if (!sub) primarySet.add(primary);
    }
    let primaryCats = Array.from(primarySet).sort();
    if (!primaryCats.length) {
      primaryCats = ['generic', 'sci-fi', 'magical', 'natural', 'grimdark'];
    }
    const options = primaryCats.map(c => `<option value="${c}">${c.charAt(0).toUpperCase() + c.slice(1)}</option>`).join('');
    const content = `<form>
      <div class="form-group">
        <label for="ta-add-subcat-prim">Primary category:</label>
        <select id="ta-add-subcat-prim">${options}</select>
      </div>
      <div class="form-group">
        <label for="ta-add-subcat-name">Subcategory ID:</label>
        <input type="text" id="ta-add-subcat-name" />
      </div>
    </form>`;
    new Dialog({
      title: 'Add Subcategory',
      content,
      buttons: {
        create: {
          label: 'Create',
          callback: async html => {
            const prim = html.find('#ta-add-subcat-prim').val();
            const rawName = html.find('#ta-add-subcat-name').val();
            const sub = this.slugify(rawName);
            if (!sub) {
              ui.notifications.warn('Subcategory ID cannot be empty.');
              return;
            }
            // Prevent duplicates by checking existing custom categories
            const custom = duplicate(game.settings.get('trap-automator', 'customDefs') || {});
            if (!custom.categories) custom.categories = {};
            if (custom.categories[sub]) {
              ui.notifications.warn('Subcategory already exists in custom definitions.');
              return;
            }
            // Add subcategory with primary reference
            custom.categories[sub] = { name: sub, primary: prim };
            await this.saveCustomDefinitions(custom);
            ui.notifications.info(`Subcategory "${sub}" added under ${prim}.`);
          }
        },
        cancel: { label: 'Cancel' }
      },
      default: 'create'
    }).render(true);
  }

  /**
   * Present a dialog allowing the GM to choose which macro should be
   * executed when a trap or cache is triggered. Macros available to the
   * current user are listed in a dropdown. Upon selection the chosen
   * macro's UUID is stored in a world setting so that it persists
   * across sessions and is used when creating new traps or caches. This
   * feature is useful if the default macro id becomes invalid or if
   * GMs wish to use a custom macro for trap resolution.
   */
  openSelectMacroDialog() {
    // Gather macros accessible to the current user. Depending on Foundry
    // version macros may be in game.macros.contents or game.macros.entities.
    let macroDocs = [];
    if (game.macros?.contents) {
      macroDocs = game.macros.contents;
    } else if (Array.isArray(game.macros)) {
      macroDocs = game.macros;
    } else if (game.macros?.entities) {
      macroDocs = game.macros.entities;
    }
    // Build options list sorted by name. Include both name and id for clarity.
    macroDocs = macroDocs.sort((a, b) => a.name.localeCompare(b.name));
    const currentUuid = game.settings.get('trap-automator', 'macroId') || '';
    const options = macroDocs.map(macro => {
      const uuid = macro.uuid ?? `Macro.${macro.id}`;
      const selected = uuid === currentUuid ? ' selected' : '';
      const label = `${macro.name} (${uuid})`;
      return `<option value="${uuid}"${selected}>${label}</option>`;
    }).join('');
    const content = `<form>
      <div class="form-group">
        <label for="ta-select-macro">Select macro:</label>
        <select id="ta-select-macro" name="ta-select-macro" style="width:100%">
          ${options}
        </select>
      </div>
    </form>`;
    new Dialog({
      title: 'Select Macro',
      content,
      buttons: {
        save: {
          label: 'Save',
          callback: async html => {
            const uuid = html.find('#ta-select-macro').val();
            if (!uuid) {
              ui.notifications.warn('No macro selected.');
              return;
            }
            await game.settings.set('trap-automator', 'macroId', uuid);
            ui.notifications.info('Trap Automator: macro updated. New traps will use the selected macro.');
          }
        },
        cancel: {
          label: 'Cancel'
        }
      },
      default: 'save'
    }).render(true);
  }

  /**
   * Dialog for editing categories. Currently supports renaming or deleting
   * custom categories. Built‑in categories cannot be removed; editing
   * built‑in categories will create a custom override that simply stores
   * the new name. To keep things simple, renaming updates only the
   * category key in custom definitions and does not cascade changes to
   * existing traps or caches.
   */
  openEditCategoryDialog() {
    // Retrieve categories from builtin and custom definitions
    const cats = this.getAllCategories();
    if (!cats.length) {
      ui.notifications.warn('No categories available to edit.');
      return;
    }
    const options = cats.map(c => `<option value="${c}">${c}</option>`).join('');
    const content = `<form>
      <div class="form-group">
        <label for="ta-edit-cat-sel">Select category:</label>
        <select id="ta-edit-cat-sel" name="ta-edit-cat-sel">
          ${options}
        </select>
      </div>
      <div class="form-group">
        <label for="ta-edit-cat-new">New name (slug):</label>
        <input type="text" id="ta-edit-cat-new" name="ta-edit-cat-new" />
      </div>
    </form>`;
    new Dialog({
      title: 'Edit Category',
      content,
      buttons: {
        save: {
          label: 'Save',
          callback: async html => {
            const oldCat = html.find('#ta-edit-cat-sel').val();
            const newCat = this.slugify(html.find('#ta-edit-cat-new').val());
            if (!newCat) {
              ui.notifications.warn('You must enter a new category name.');
              return;
            }
            const custom = duplicate(game.settings.get('trap-automator', 'customDefs') || {});
            if (!custom.categories) custom.categories = {};
            // Rename custom category or create override
            delete custom.categories[oldCat];
            custom.categories[newCat] = { name: newCat };
            await this.saveCustomDefinitions(custom);
            ui.notifications.info(`Category "${oldCat}" renamed to "${newCat}".`);
          }
        },
        delete: {
          label: 'Delete',
          callback: async html => {
            const catToDelete = html.find('#ta-edit-cat-sel').val();
            // Only allow deletion of custom categories
            const custom = duplicate(game.settings.get('trap-automator', 'customDefs') || {});
            if (!custom.categories || !custom.categories[catToDelete]) {
              ui.notifications.warn('Only custom categories may be deleted.');
              return;
            }
            // Confirm deletion
            new Dialog({
              title: 'Confirm Deletion',
              content: `<p>Are you sure you want to delete the category "${catToDelete}" and all associated triggers, traps and caches?</p>`,
              buttons: {
                yes: {
                  label: 'Delete',
                  callback: async () => {
                    // Remove category
                    delete custom.categories[catToDelete];
                    // Remove any custom triggers under this category
                    if (custom.triggers && custom.triggers[catToDelete]) delete custom.triggers[catToDelete];
                    // Remove custom traps with this category
                    if (custom.trap) {
                      for (const [k, v] of Object.entries(custom.trap)) {
                        if (v.category === catToDelete) delete custom.trap[k];
                      }
                    }
                    // Remove custom caches with this category
                    if (custom.cache) {
                      for (const [k, v] of Object.entries(custom.cache)) {
                        if (v.category === catToDelete) delete custom.cache[k];
                      }
                    }
                    // Remove subcategories referencing this category
                    if (custom.categories) {
                      for (const [k, v] of Object.entries(custom.categories)) {
                        if (v.primary === catToDelete) delete custom.categories[k];
                      }
                    }
                    await this.saveCustomDefinitions(custom);
                    ui.notifications.info(`Category "${catToDelete}" and related definitions deleted.`);
                  }
                },
                no: { label: 'Cancel' }
              },
              default: 'no'
            }).render(true);
          }
        },
        cancel: { label: 'Cancel' }
      },
      default: 'save'
    }).render(true);
  }

  /**
   * Dialog for editing triggers. Allows selecting a category and a trigger
   * within that category, then modifying its text. If the trigger is from
   * builtin definitions a new custom override will be created.
   */
  openEditTriggerDialog() {
    // Build mapping of categories to triggers from builtin and custom defs
    const trigMap = {};
    // builtin triggers: our default list is stored in definitions.triggers.all or by category if defined
    if (this.definitions.triggers) {
      for (const cat of Object.keys(this.definitions.triggers)) {
        if (!trigMap[cat]) trigMap[cat] = [];
        trigMap[cat] = trigMap[cat].concat(this.definitions.triggers[cat]);
      }
    }
    try {
      const custom = game.settings.get('trap-automator', 'customDefs') || {};
      if (custom.triggers) {
        for (const cat of Object.keys(custom.triggers)) {
          if (!trigMap[cat]) trigMap[cat] = [];
          trigMap[cat] = trigMap[cat].concat(custom.triggers[cat]);
        }
      }
    } catch (err) {}
    const cats = Object.keys(trigMap);
    if (!cats.length) {
      ui.notifications.warn('No triggers available to edit.');
      return;
    }
    const catOptions = cats.map(c => `<option value="${c}">${c}</option>`).join('');
    const buildTriggerSelect = cat => {
      const trigs = trigMap[cat] || [];
      return trigs.map(t => `<option value="${t}">${t}</option>`).join('');
    };
    let selectedCat = cats[0];
    let trigOptions = buildTriggerSelect(selectedCat);
    const content = `<form id="ta-edit-trigger-form">
      <div class="form-group">
        <label for="ta-edit-trig-cat">Category:</label>
        <select id="ta-edit-trig-cat" name="ta-edit-trig-cat">
          ${catOptions}
        </select>
      </div>
      <div class="form-group">
        <label for="ta-edit-trig-sel">Trigger:</label>
        <select id="ta-edit-trig-sel" name="ta-edit-trig-sel">
          ${trigOptions}
        </select>
      </div>
      <div class="form-group">
        <label for="ta-edit-trig-new">New trigger text:</label>
        <input type="text" id="ta-edit-trig-new" name="ta-edit-trig-new" />
      </div>
    </form>`;
    const dlg = new Dialog({
      title: 'Edit Trigger',
      content,
      buttons: {
        save: {
          label: 'Save',
          callback: async html => {
            const catVal = html.find('#ta-edit-trig-cat').val();
            const oldTrig = html.find('#ta-edit-trig-sel').val();
            const newTrig = html.find('#ta-edit-trig-new').val().trim();
            if (!newTrig) {
              ui.notifications.warn('You must enter a new trigger text.');
              return;
            }
            // Build custom object and replace the trigger
            const custom = duplicate(game.settings.get('trap-automator', 'customDefs') || {});
            if (!custom.triggers) custom.triggers = {};
            // Remove old trigger if exists in custom for the category
            if (!custom.triggers[catVal]) custom.triggers[catVal] = [];
            // Remove from custom
            custom.triggers[catVal] = custom.triggers[catVal].filter(t => t !== oldTrig);
            // Also remove from builtin override by adding a new custom list excluding the old trigger
            // Add the new trigger
            custom.triggers[catVal].push(newTrig);
            await this.saveCustomDefinitions(custom);
            ui.notifications.info(`Trigger updated under category "${catVal}".`);
          }
        },
        delete: {
          label: 'Delete',
          callback: async html => {
            const catVal = html.find('#ta-edit-trig-cat').val();
            const oldTrig = html.find('#ta-edit-trig-sel').val();
            // Determine full list of triggers for this category
            const baseList = (this.definitions.triggers && this.definitions.triggers[catVal]) ? Array.from(this.definitions.triggers[catVal]) : [];
            // Merge in custom triggers
            try {
              const custom = game.settings.get('trap-automator', 'customDefs') || {};
              if (custom.triggers && Array.isArray(custom.triggers[catVal])) {
                for (const t of custom.triggers[catVal]) {
                  if (!baseList.includes(t)) baseList.push(t);
                }
              }
            } catch (err) {}
            if (!baseList.includes(oldTrig)) {
              ui.notifications.warn('Cannot delete a trigger that is not defined.');
              return;
            }
            // Show confirm dialog
            new Dialog({
              title: 'Confirm Deletion',
              content: `<p>Are you sure you want to delete the trigger "${oldTrig}" from category ${catVal}?</p>`,
              buttons: {
                yes: {
                  label: 'Delete',
                  callback: async () => {
                    const custom = duplicate(game.settings.get('trap-automator', 'customDefs') || {});
                    if (!custom.triggers) custom.triggers = {};
                    // Build new list excluding the old trigger
                    const newList = baseList.filter(t => t !== oldTrig);
                    custom.triggers[catVal] = newList;
                    await this.saveCustomDefinitions(custom);
                    ui.notifications.info(`Trigger "${oldTrig}" deleted from category "${catVal}".`);
                  }
                },
                no: { label: 'Cancel' }
              },
              default: 'no'
            }).render(true);
          }
        },
        cancel: { label: 'Cancel' }
      },
      default: 'save'
    });
    dlg.render(true);
    // On category change update triggers
    $(document).on('change.taEditTrig', '#ta-edit-trig-cat', function() {
      const catVal = this.value;
      const select = $('#ta-edit-trig-sel');
      select.empty();
      const opts = trigMap[catVal] || [];
      for (const t of opts) {
        select.append(new Option(t, t));
      }
    });
    Hooks.once('closeDialog', () => {
      $(document).off('change.taEditTrig');
    });
  }

  /**
   * Dialog for editing a cache. Prompts the user to select a category and
   * then choose a cache from that category (including built‑in definitions).
   * The cache fields are prepopulated and can be modified. Changes are
   * stored as custom overrides in the world setting.
   */
  openEditCacheDialog() {
    // Build mapping of category->cache keys with names
    const catMap = {};
    for (const key of Object.keys(this.definitions.cache || {})) {
      const def = this.definitions.cache[key];
      const cat = def.category || 'misc';
      if (!catMap[cat]) catMap[cat] = [];
      catMap[cat].push({ key, name: def.name || key, def });
    }
    const cats = Object.keys(catMap);
    if (!cats.length) {
      ui.notifications.warn('No caches available to edit.');
      return;
    }
    const catOptions = cats.map(c => `<option value="${c}">${c}</option>`).join('');
    const buildCacheSelect = cat => {
      return catMap[cat].map(({ key, name }) => `<option value="${key}">${name}</option>`).join('');
    };
    let selectedCat = cats[0];
    let cacheOptions = buildCacheSelect(selectedCat);
    const buildForm = (cat, key) => {
      const def = (catMap[cat].find(item => item.key === key) || {}).def;
      const sets = [];
      // Convert hints to array of sets. If hints[loc] is array treat as sets, else assemble sets from diff arrays
      if (def.hints && def.hints.floor) {
        const h = def.hints.floor;
        if (Array.isArray(h)) {
          for (const set of h) sets.push(set);
        } else {
          // Build sets from diff arrays; assume arrays all same length; choose length of +2 array
          const plus2 = h['+2'] || [];
          for (let i = 0; i < plus2.length; i++) {
            const set = {
              '+2': h['+2'][i] || '',
              '+4': (h['+4'] && h['+4'][i]) || '',
              '+6': (h['+6'] && h['+6'][i]) || '',
              '+10': (h['+10'] && h['+10'][i]) || ''
            };
            sets.push(set);
          }
        }
      }
      let setsHtml = '';
      sets.forEach((set, idx) => {
        setsHtml += this._renderHintSet(idx);
      });
      if (!setsHtml) setsHtml = this._renderHintSet(0);
      const content = `<form id="ta-edit-cache-form">
        <div class="form-group">
          <label for="ta-edit-cache-cat">Category:</label>
          <select id="ta-edit-cache-cat" name="ta-edit-cache-cat">
            ${catOptions}
          </select>
        </div>
        <div class="form-group">
          <label for="ta-edit-cache-key">Cache:</label>
          <select id="ta-edit-cache-key" name="ta-edit-cache-key">
            ${cacheOptions}
          </select>
        </div>
        <div class="form-group">
          <label for="ta-edit-cache-name">Name:</label>
          <input type="text" id="ta-edit-cache-name" value="${def.name || ''}" />
        </div>
        <div class="form-group">
          <label for="ta-edit-cache-desc">Description:</label>
          <textarea id="ta-edit-cache-desc" rows="3">${(def.description && def.description.found) || ''}</textarea>
        </div>
        <hr/>
        <h3>Hint Sets</h3>
        <div id="ta-edit-cache-sets">${setsHtml}</div>
        <button type="button" id="ta-edit-cache-addset">Add Another Set</button>
      </form>`;
      return content;
    };
    // Outer dialog for selecting which cache to edit
    const outerContent = `<form id="ta-edit-cache-select">
      <div class="form-group">
        <label for="ta-edit-cache-cat-sel">Category:</label>
        <select id="ta-edit-cache-cat-sel">${catOptions}</select>
      </div>
      <div class="form-group">
        <label for="ta-edit-cache-key-sel">Cache:</label>
        <select id="ta-edit-cache-key-sel">${cacheOptions}</select>
      </div>
    </form>`;
    const dlg = new Dialog({
      title: 'Select Cache to Edit',
      content: outerContent,
      buttons: {
        next: {
          label: 'Next',
          callback: html => {
            const catVal = html.find('#ta-edit-cache-cat-sel').val();
            const keyVal = html.find('#ta-edit-cache-key-sel').val();
            // Open editing form
            this.openEditCacheForm(catVal, keyVal, catMap);
          }
        },
        cancel: { label: 'Cancel' }
      },
      default: 'next'
    });
    dlg.render(true);
    $(document).on('change.taEditCacheSel', '#ta-edit-cache-cat-sel', function() {
      const catVal = this.value;
      const select = $('#ta-edit-cache-key-sel');
      select.empty();
      for (const { key, name } of catMap[catVal]) {
        select.append(new Option(name, key));
      }
    });
    Hooks.once('closeDialog', () => {
      $(document).off('change.taEditCacheSel');
    });
  }

  /**
   * Helper to open the actual cache editing form after a cache has been
   * selected. Accepts the category and key, and a precomputed mapping of
   * categories to definitions. Allows adding/removing hint sets and
   * modifying name/description. Saves as a custom override on submit.
   * @param {string} cat Selected category
   * @param {string} key Selected cache key
   * @param {Object} catMap Precomputed map of category->[{key,name,def}]
   */
  openEditCacheForm(cat, key, catMap) {
    const def = (catMap[cat].find(item => item.key === key) || {}).def;
    if (!def) {
      ui.notifications.error('Selected cache definition not found.');
      return;
    }
    // Build sets from existing definition
    const sets = [];
    if (def.hints && def.hints.floor) {
      const h = def.hints.floor;
      if (Array.isArray(h)) {
        for (const set of h) sets.push(set);
      } else {
        const plus2 = h['+2'] || [];
        for (let i = 0; i < plus2.length; i++) {
          sets.push({
            '+2': h['+2'][i] || '',
            '+4': (h['+4'] && h['+4'][i]) || '',
            '+6': (h['+6'] && h['+6'][i]) || '',
            '+10': (h['+10'] && h['+10'][i]) || ''
          });
        }
      }
    }
    let setsHtml = '';
    sets.forEach((s, idx) => {
      setsHtml += `<div class="ta-hint-set" data-idx="${idx}" style="margin-bottom:1em;border:1px solid #666;padding:0.5em;">
        <strong>Set ${idx + 1}</strong><br/>
        <label>+2:</label> <input type="text" name="hint-${idx}-2" value="${s['+2'] || ''}" /><br/>
        <label>+4:</label> <input type="text" name="hint-${idx}-4" value="${s['+4'] || ''}" /><br/>
        <label>+6:</label> <input type="text" name="hint-${idx}-6" value="${s['+6'] || ''}" /><br/>
        <label>+10:</label> <input type="text" name="hint-${idx}-10" value="${s['+10'] || ''}" /><br/>
      </div>`;
    });
    if (!setsHtml) setsHtml = this._renderHintSet(0);
    const content = `<form id="ta-edit-cache-form2">
      <div class="form-group">
        <label for="ta-edit-cache-name2">Name:</label>
        <input type="text" id="ta-edit-cache-name2" value="${def.name || ''}" />
      </div>
      <div class="form-group">
        <label for="ta-edit-cache-desc2">Description:</label>
        <textarea id="ta-edit-cache-desc2" rows="3">${(def.description && def.description.found) || ''}</textarea>
      </div>
      <hr/>
      <h3>Hint Sets</h3>
      <div id="ta-edit-cache-sets2">${setsHtml}</div>
      <button type="button" id="ta-edit-cache-addset2">Add Another Set</button>
    </form>`;
    const dlg = new Dialog({
      title: `Edit Cache: ${def.name || key}`,
      content,
      buttons: {
        save: {
          label: 'Save',
          callback: async html => {
            const newName = html.find('#ta-edit-cache-name2').val().trim();
            const newDesc = html.find('#ta-edit-cache-desc2').val().trim();
            // Build sets
            const sets2 = [];
            html.find('.ta-hint-set').each((idx, el) => {
              const $el = $(el);
              const i = $el.data('idx');
              sets2.push({
                '+2': $el.find(`[name="hint-${i}-2"]`).val().trim(),
                '+4': $el.find(`[name="hint-${i}-4"]`).val().trim(),
                '+6': $el.find(`[name="hint-${i}-6"]`).val().trim(),
                '+10': $el.find(`[name="hint-${i}-10"]`).val().trim()
              });
            });
            const custom = duplicate(game.settings.get('trap-automator', 'customDefs') || {});
            if (!custom.cache) custom.cache = {};
            custom.cache[key] = {
              name: newName || key,
              category: cat,
              description: { found: newDesc },
              hints: {
                floor: sets2,
                wall: sets2,
                ceiling: sets2,
                other: sets2
              }
            };
            await this.saveCustomDefinitions(custom);
            ui.notifications.info(`Cache "${newName || def.name}" saved.`);
          }
        },
        delete: {
          label: 'Delete',
          callback: () => {
            // Only allow deletion of custom caches
            const customDefs = game.settings.get('trap-automator', 'customDefs') || {};
            if (!customDefs.cache || !customDefs.cache[key]) {
              ui.notifications.warn('Only custom caches may be deleted.');
              return;
            }
            new Dialog({
              title: 'Confirm Deletion',
              content: `<p>Are you sure you want to delete the cache "${def.name || key}"?</p>`,
              buttons: {
                yes: {
                  label: 'Delete',
                  callback: async () => {
                    const custom = duplicate(customDefs);
                    delete custom.cache[key];
                    await this.saveCustomDefinitions(custom);
                    ui.notifications.info(`Cache "${def.name || key}" deleted.`);
                  }
                },
                no: { label: 'Cancel' }
              },
              default: 'no'
            }).render(true);
          }
        },
        cancel: { label: 'Cancel' }
      },
      default: 'save'
    });
    dlg.render(true);
    $(document).on('click.taEditCache', '#ta-edit-cache-addset2', ev => {
      ev.preventDefault();
      const container = $('#ta-edit-cache-sets2');
      const idx = container.children('.ta-hint-set').length;
      container.append(this._renderHintSet(idx));
    });
    Hooks.once('closeDialog', () => {
      $(document).off('click.taEditCache');
    });
  }

  /**
   * Dialog for editing a trap. Works similarly to editing caches: prompts for
   * category and trap selection, then provides a form to edit the trap
   * fields and hint sets. The updated trap is stored as a custom override.
   */
  openEditTrapDialog() {
    // Build category -> trap map
    const catMap = {};
    for (const key of Object.keys(this.definitions.trap || {})) {
      const def = this.definitions.trap[key];
      const cat = def.category || 'misc';
      if (!catMap[cat]) catMap[cat] = [];
      catMap[cat].push({ key, name: def.name || key, def });
    }
    const cats = Object.keys(catMap);
    if (!cats.length) {
      ui.notifications.warn('No traps available to edit.');
      return;
    }
    // Ask user to select a category first; then open trap selection
    const catOptions = cats.map(c => `<option value="${c}">${c}</option>`).join('');
    const content = `<form>
      <div class="form-group">
        <label for="ta-edit-trap-cat-sel">Select category:</label>
        <select id="ta-edit-trap-cat-sel" name="ta-edit-trap-cat-sel">
          ${catOptions}
        </select>
      </div>
    </form>`;
    new Dialog({
      title: 'Select Trap Category',
      content,
      buttons: {
        next: {
          label: 'Next',
          callback: html => {
            const catVal = html.find('#ta-edit-trap-cat-sel').val();
            this.openEditTrapSelect(catVal, catMap);
          }
        },
        cancel: { label: 'Cancel' }
      },
      default: 'next'
    }).render(true);
  }

  /**
   * Internal helper used by openEditTrapDialog. After the user selects a category
   * this dialog prompts them to choose a trap within that category before
   * opening the edit form. A back button allows returning to category
   * selection.
   * @param {string} cat Selected category
   * @param {Object} catMap Precomputed category -> trap list
   */
  openEditTrapSelect(cat, catMap) {
    const traps = catMap[cat] || [];
    if (!traps.length) {
      ui.notifications.warn('No traps available in the selected category.');
      return;
    }
    const trapOptions = traps.map(({ key, name }) => `<option value="${key}">${name}</option>`).join('');
    const content = `<form>
      <div class="form-group">
        <label for="ta-edit-trap-key-sel">Select trap:</label>
        <select id="ta-edit-trap-key-sel" name="ta-edit-trap-key-sel">
          ${trapOptions}
        </select>
      </div>
    </form>`;
    new Dialog({
      title: `Select Trap in ${cat}`,
      content,
      buttons: {
        next: {
          label: 'Next',
          callback: html => {
            const key = html.find('#ta-edit-trap-key-sel').val();
            this.openEditTrapForm(cat, key, catMap);
          }
        },
        back: {
          label: 'Back',
          callback: () => {
            // Return to initial category selection
            this.openEditTrapDialog();
          }
        }
      },
      default: 'next'
    }).render(true);
  }

  /**
   * Helper to open the actual trap editing form. Prepopulates fields
   * including save ability, description, failure, success and hint sets.
   * After editing the trap is stored as a custom override.
   * @param {string} cat Selected category
   * @param {string} key Selected trap key
   * @param {Object} catMap Precomputed map of categories to trap definitions
   */
  openEditTrapForm(cat, key, catMap) {
    const entry = (catMap[cat] || []).find(item => item.key === key);
    const def = entry && entry.def;
    if (!def) {
      ui.notifications.error('Selected trap definition not found.');
      return;
    }
    // Build hint sets from definition
    const sets = [];
    if (def.hints && def.hints.floor) {
      const h = def.hints.floor;
      if (Array.isArray(h)) {
        for (const set of h) sets.push(set);
      } else {
        const plus2 = h['+2'] || [];
        for (let i = 0; i < plus2.length; i++) {
          sets.push({
            '+2': h['+2'][i] || '',
            '+4': (h['+4'] && h['+4'][i]) || '',
            '+6': (h['+6'] && h['+6'][i]) || '',
            '+10': (h['+10'] && h['+10'][i]) || ''
          });
        }
      }
    }
    let setsHtml = '';
    sets.forEach((s, idx) => {
      setsHtml += `<div class="ta-hint-set" data-idx="${idx}" style="margin-bottom:1em;border:1px solid #666;padding:0.5em;">
        <strong>Set ${idx + 1}</strong><br/>
        <label>+2:</label> <input type="text" name="hint-${idx}-2" value="${s['+2'] || ''}" /><br/>
        <label>+4:</label> <input type="text" name="hint-${idx}-4" value="${s['+4'] || ''}" /><br/>
        <label>+6:</label> <input type="text" name="hint-${idx}-6" value="${s['+6'] || ''}" /><br/>
        <label>+10:</label> <input type="text" name="hint-${idx}-10" value="${s['+10'] || ''}" /><br/>
      </div>`;
    });
    if (!setsHtml) setsHtml = this._renderHintSet(0);
    const saveTypes = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
    const saveOpts = saveTypes.map(s => `<option value="${s}"${def.defaultSave && def.defaultSave.toLowerCase() === s ? ' selected' : ''}>${s.toUpperCase()}</option>`).join('');
    const content = `<form id="ta-edit-trap-form2">
      <div class="form-group">
        <label for="ta-edit-trap-name2">Name:</label>
        <input type="text" id="ta-edit-trap-name2" value="${def.name || key}" />
      </div>
      <div class="form-group">
        <label for="ta-edit-trap-save2">Default Save Ability:</label>
        <select id="ta-edit-trap-save2">${saveOpts}</select>
      </div>
      <div class="form-group">
        <label for="ta-edit-trap-desc2">Description:</label>
        <textarea id="ta-edit-trap-desc2" rows="2">${(def.description && def.description.flavor) || ''}</textarea>
      </div>
      <div class="form-group">
        <label for="ta-edit-trap-fail2">Failure Text:</label>
        <input type="text" id="ta-edit-trap-fail2" value="${(def.description && def.description.fail) || ''}" />
      </div>
      <div class="form-group">
        <label for="ta-edit-trap-success2">Success Text:</label>
        <input type="text" id="ta-edit-trap-success2" value="${(def.description && def.description.success) || ''}" />
      </div>
      <hr/>
      <h3>Hint Sets</h3>
      <div id="ta-edit-trap-sets2">${setsHtml}</div>
      <button type="button" id="ta-edit-trap-addset2">Add Another Set</button>
    </form>`;
    const dlg = new Dialog({
      title: `Edit Trap: ${def.name || key}`,
      content,
      buttons: {
        save: {
          label: 'Save',
          callback: async html => {
            const newName = html.find('#ta-edit-trap-name2').val().trim();
            const newSave = html.find('#ta-edit-trap-save2').val();
            const newDesc = html.find('#ta-edit-trap-desc2').val().trim();
            const newFail = html.find('#ta-edit-trap-fail2').val().trim();
            const newSuccess = html.find('#ta-edit-trap-success2').val().trim();
            const sets2 = [];
            html.find('.ta-hint-set').each((idx, el) => {
              const $el = $(el);
              const i = $el.data('idx');
              sets2.push({
                '+2': $el.find(`[name="hint-${i}-2"]`).val().trim(),
                '+4': $el.find(`[name="hint-${i}-4"]`).val().trim(),
                '+6': $el.find(`[name="hint-${i}-6"]`).val().trim(),
                '+10': $el.find(`[name="hint-${i}-10"]`).val().trim()
              });
            });
            const custom = duplicate(game.settings.get('trap-automator', 'customDefs') || {});
            if (!custom.trap) custom.trap = {};
            custom.trap[key] = {
              name: newName || key,
              category: cat,
              defaultSave: newSave,
              defaultDC: def.defaultDC || 10,
              description: {
                flavor: newDesc,
                fail: newFail,
                success: newSuccess
              },
              hints: {
                floor: sets2,
                wall: sets2,
                ceiling: sets2,
                other: sets2
              }
            };
            await this.saveCustomDefinitions(custom);
            ui.notifications.info(`Trap "${newName || def.name}" saved.`);
          }
        },
        delete: {
          label: 'Delete',
          callback: () => {
            // Only allow deletion of custom traps
            const customDefs = game.settings.get('trap-automator', 'customDefs') || {};
            if (!customDefs.trap || !customDefs.trap[key]) {
              ui.notifications.warn('Only custom traps may be deleted.');
              return;
            }
            new Dialog({
              title: 'Confirm Deletion',
              content: `<p>Are you sure you want to delete the trap "${def.name || key}"?</p>`,
              buttons: {
                yes: {
                  label: 'Delete',
                  callback: async () => {
                    const custom = duplicate(customDefs);
                    delete custom.trap[key];
                    await this.saveCustomDefinitions(custom);
                    ui.notifications.info(`Trap "${def.name || key}" deleted.`);
                  }
                },
                no: { label: 'Cancel' }
              },
              default: 'no'
            }).render(true);
          }
        },
        cancel: { label: 'Cancel' }
      },
      default: 'save'
    });
    dlg.render(true);
    $(document).on('click.taEditTrap', '#ta-edit-trap-addset2', ev => {
      ev.preventDefault();
      const container = $('#ta-edit-trap-sets2');
      const idx = container.children('.ta-hint-set').length;
      container.append(this._renderHintSet(idx));
    });
    Hooks.once('closeDialog', () => {
      $(document).off('click.taEditTrap');
    });
  }

  /**
   * Show a dialog listing available trap types based on the loaded
   * definitions. Each entry uses the definition's name property if
   * present. When the GM selects a trap type the workflow proceeds to
   * select a location.
   */
  openTrapTypeDialog(primaryCat = null, subCat = null) {
    /**
     * Use the class method to categorise a category into primary and sub.
     */
    const categorise = catName => this.categorizeCategory(catName);
    // Build mapping of traps grouped by primary and sub categories
    const mapping = {};
    const defs = this.definitions.trap || {};
    for (const [key, def] of Object.entries(defs)) {
      const { primary, sub } = categorise(def.category);
      if (!mapping[primary]) mapping[primary] = {};
      const subKey = sub || '_';
      if (!mapping[primary][subKey]) mapping[primary][subKey] = [];
      mapping[primary][subKey].push({ key, name: def.name || key });
    }
    // Determine list of primary categories to display. Include built‑in
    // categories first (in a predefined order) followed by any additional
    // categories discovered in the mapping. This ensures custom categories
    // appear when traps exist for them. If no traps exist in any category
    // the user will be notified and returned to the initial menu.
    const predefined = ['generic', 'sci-fi', 'magical', 'natural', 'grimdark'];
    const mappingKeys = Object.keys(mapping);
    // Remove duplicates from mapping keys that are in predefined and sort
    const customCats = mappingKeys.filter(cat => !predefined.includes(cat)).sort();
    const availableCats = predefined.filter(pc => mapping[pc]).concat(customCats);
    if (!primaryCat) {
      if (!availableCats.length) {
        ui.notifications.error('No trap definitions are available.');
        return;
      }
      const options = availableCats
        .map(c => `<option value="${c}">${c.charAt(0).toUpperCase() + c.slice(1)}</option>`) 
        .join('');
      const content = `<form>
        <div class="form-group">
          <label for="ta-trap-cat">Select category:</label>
          <select id="ta-trap-cat" name="ta-trap-cat">${options}</select>
        </div>
      </form>`;
      new Dialog({
        title: 'Select Trap Category',
        content,
        buttons: {
          next: {
            label: 'Next',
            callback: html => {
              const pc = html.find('#ta-trap-cat').val();
              this.openTrapTypeDialog(pc);
            }
          },
          back: {
            label: 'Back',
            callback: () => this.openInitialDialog()
          }
        },
        default: 'next'
      }).render(true);
      return;
    }
    // If the chosen primary category has multiple subcategories (excluding '_'),
    // prompt the user to select a subcategory if not already provided.
    if (primaryCat && !subCat) {
      const subMap = mapping[primaryCat];
      if (subMap) {
        const subKeys = Object.keys(subMap).filter(k => k !== '_' && subMap[k].length);
        if (subKeys.length > 0) {
          const options = subKeys
            .map(s => `<option value="${s}">${s.charAt(0).toUpperCase() + s.slice(1)}</option>`)
            .join('');
          const content = `<form>
            <div class="form-group">
              <label for="ta-trap-subcat">Select ${primaryCat.charAt(0).toUpperCase() + primaryCat.slice(1)} sub-category:</label>
              <select id="ta-trap-subcat" name="ta-trap-subcat">${options}</select>
            </div>
          </form>`;
          new Dialog({
            title: `Select ${primaryCat.charAt(0).toUpperCase() + primaryCat.slice(1)} Sub-category`,
            content,
            buttons: {
              next: {
                label: 'Next',
                callback: html => {
                  const sc = html.find('#ta-trap-subcat').val();
                  this.openTrapTypeDialog(primaryCat, sc);
                }
              },
              back: {
                label: 'Back',
                callback: () => this.openTrapTypeDialog()
              }
            },
            default: 'next'
          }).render(true);
          return;
        }
      }
    }
    // Now we have a category (and subcategory if grimdark). List traps accordingly.
    let traps = [];
    if (primaryCat) {
      const subMap = mapping[primaryCat];
      if (subCat && subMap) {
        traps = (subMap[subCat] || []).slice();
      } else if (subMap) {
        // Use default group '_' if exists
        traps = (subMap['_'] || []).slice();
        // If default group empty but there are other subgroups, merge them
        if (!traps.length) {
          for (const [k, arr] of Object.entries(subMap)) {
            traps = traps.concat(arr);
          }
        }
      }
    } else {
      // Should not happen, handled above
      traps = [];
    }
    if (!traps.length) {
      ui.notifications.warn('No traps available for the selected category.');
      // Go back to category selection
      this.openTrapTypeDialog();
      return;
    }
    const options = traps
      .map(({ key, name }) => `<option value="${key}">${name}</option>`) 
      .join('');
    const content = `<form>
      <div class="form-group">
        <label for="ta-trap-type">Select trap type:</label>
        <select id="ta-trap-type" name="ta-trap-type">${options}</select>
      </div>
    </form>`;
    new Dialog({
      title: 'Select Trap Type',
      content,
      buttons: {
        next: {
          label: 'Next',
          callback: html => {
            const key = html.find('#ta-trap-type').val();
            this.currentData.key = key;
            this.openLocationDialog();
          }
        },
        back: {
          label: 'Back',
          callback: () => this.openTrapTypeDialog()
        }
      },
      default: 'next'
    }).render(true);
  }

  /**
   * Show a dialog listing available cache types based on the loaded
   * definitions. When the GM selects a cache type the workflow proceeds
   * directly to ask for a location and description.
   */
  openCacheTypeDialog() {
    const cacheDefs = this.definitions.cache || {};
    if (!Object.keys(cacheDefs).length) {
      ui.notifications.error('No cache definitions are available.');
      return;
    }
    const options = Object.entries(cacheDefs)
      .map(([key, def]) => `<option value="${key}">${def.name || key}</option>`)
      .join('');
    const content = `<form>
      <div class="form-group">
        <label for="ta-cache-type">Select cache type:</label>
        <select id="ta-cache-type" name="ta-cache-type">${options}</select>
      </div>
    </form>`;
    new Dialog({
      title: 'Select Cache Type',
      content,
      buttons: {
        next: {
          label: 'Next',
          callback: html => {
            const key = html.find('#ta-cache-type').val();
            this.currentData.key = key;
            this.openLocationDialog();
          }
        },
        back: {
          label: 'Back',
          callback: () => this.openInitialDialog()
        }
      },
      default: 'next'
    }).render(true);
  }

  /**
   * Prompt the GM to select where the trap or cache is located. Four
   * standard options are provided: floor, wall, ceiling and other. When
   * selected the workflow proceeds to either trigger selection (for traps)
   * or cache description (for caches).
   */
  openLocationDialog() {
    const locations = ['floor', 'wall', 'ceiling', 'other'];
    const options = locations
      .map(l => `<option value="${l}">${l.charAt(0).toUpperCase() + l.slice(1)}</option>`)
      .join('');
    const content = `<form>
      <div class="form-group">
        <label for="ta-location">Where is it located?</label>
        <select id="ta-location" name="ta-location">${options}</select>
      </div>
    </form>`;
    new Dialog({
      title: 'Select Location',
      content,
      buttons: {
        next: {
          label: 'Next',
          callback: html => {
            const loc = html.find('#ta-location').val();
            this.currentData.location = loc;
            if (this.currentData.type === 'trap') {
              this.openTriggerDialog();
            } else {
              this.openCacheDetailsDialog();
            }
          }
        },
        back: {
          label: 'Back',
          callback: () => {
            if (this.currentData.type === 'trap') this.openTrapTypeDialog();
            else this.openCacheTypeDialog();
          }
        }
      },
      default: 'next'
    }).render(true);
  }

  /**
   * Prompt the GM to select the trigger mechanism that activates the trap.
   * A basic list of triggers is provided; custom triggers from the
   * definitions object may be appended. After selection the workflow
   * proceeds to ask for trap details (DC, save type, damage, etc.).
   */
  openTriggerDialog() {
    // Build triggers list based on the trap's category. Each category has its own set
    // of trigger phrases stored in definitions.triggers. Subcategories share their
    // parent's triggers. If no triggers exist for a category, fall back to generic.
    let triggers = [];
    const def = this.definitions.trap && this.currentData.key ? this.definitions.trap[this.currentData.key] : null;
    let catKey = null;
    if (def && def.category) {
      const { primary, sub } = this.categorizeCategory(def.category);
      // Use subcategory key if triggers defined, otherwise primary
      const subList = this.definitions.triggers && Array.isArray(this.definitions.triggers[sub]) && this.definitions.triggers[sub].length;
      catKey = sub && subList ? sub : primary;
    }
    if (catKey && this.definitions.triggers && Array.isArray(this.definitions.triggers[catKey])) {
      triggers = this.definitions.triggers[catKey].slice();
    }
    // Fallback to generic triggers if still empty
    if (!triggers.length && this.definitions.triggers && Array.isArray(this.definitions.triggers['generic'])) {
      triggers = this.definitions.triggers['generic'].slice();
    }
    // Deduplicate triggers while preserving order
    const seen = new Set();
    triggers = triggers.filter(t => {
      const key = String(t).trim();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    // If no triggers defined at all, prompt the GM to add triggers first
    if (!triggers.length) {
      ui.notifications.error('No triggers are defined for this category. Please add triggers via Add Definition → Trigger before creating a trap.');
      // Return to location selection so the GM can cancel or go back
      this.openLocationDialog();
      return;
    }
    // Build option HTML with capitalised display
    const options = triggers.map(t => {
      const display = t.charAt(0).toUpperCase() + t.slice(1);
      return `<option value="${t}">${display}</option>`;
    }).join('');
    const content = `<form>
      <div class="form-group">
        <label for="ta-trigger">Select the trigger mechanism:</label>
        <select id="ta-trigger" name="ta-trigger">${options}</select>
      </div>
    </form>`;
    new Dialog({
      title: 'Select Trigger',
      content,
      buttons: {
        next: {
          label: 'Next',
          callback: html => {
            const trig = html.find('#ta-trigger').val();
            this.currentData.trigger = trig;
            this.openTrapDetailsDialog();
          }
        },
        back: {
          label: 'Back',
          callback: () => this.openLocationDialog()
        }
      },
      default: 'next'
    }).render(true);
  }

  /**
   * Prompt the GM to enter trap-specific details such as the saving throw
   * difficulty class (DC), save ability, damage formula and type, whether
   * damage is halved on success, and any additional effect description.
   * Once entered the workflow asks the GM to draw the tile.
   */
  openTrapDetailsDialog() {
    const def = this.definitions.trap[this.currentData.key];
    const saveTypes = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
    const saveOptions = saveTypes
      .map(s => `<option value="${s}"${def.defaultSave && def.defaultSave.toLowerCase() === s ? ' selected' : ''}>${s.toUpperCase()}</option>`)
      .join('');
    const content = `<form>
      <div class="form-group">
        <label for="ta-dc">Save DC:</label>
        <input id="ta-dc" name="ta-dc" type="number" min="1" max="30" value="${def.defaultDC || 10}" />
      </div>
      <div class="form-group">
        <label for="ta-save-type">Save ability:</label>
        <select id="ta-save-type" name="ta-save-type">${saveOptions}</select>
      </div>
      <div class="form-group">
        <label for="ta-damage">Damage formula:</label>
        <input id="ta-damage" name="ta-damage" type="text" placeholder="e.g. 2d6 + 3" />
      </div>
      <div class="form-group">
        <label for="ta-damage-type">Damage type:</label>
        <input id="ta-damage-type" name="ta-damage-type" type="text" placeholder="e.g. slashing" />
      </div>
      <div class="form-group">
        <label><input id="ta-half" name="ta-half" type="checkbox" /> Half damage on success</label>
      </div>
      <div class="form-group">
        <label for="ta-effect">Additional effect (optional):</label>
        <input id="ta-effect" name="ta-effect" type="text" />
      </div>
    </form>`;
    new Dialog({
      title: 'Trap Details',
      content,
      buttons: {
        create: {
          label: 'Continue',
          callback: html => {
            this.currentData.dc = Number(html.find('#ta-dc').val());
            this.currentData.saveType = html.find('#ta-save-type').val();
            this.currentData.damage = html.find('#ta-damage').val().trim();
            this.currentData.damageType = html.find('#ta-damage-type').val().trim();
            this.currentData.half = html.find('#ta-half')[0].checked;
            this.currentData.effect = html.find('#ta-effect').val().trim();
            this.promptDrawTile();
          }
        },
        back: {
          label: 'Back',
          callback: () => this.openTriggerDialog()
        }
      },
      default: 'create'
    }).render(true);
  }

  /**
   * Prompt the GM to enter additional description for a cache. Caches do
   * not involve saving throws or damage. After entering the description
   * the workflow asks the GM to draw the tile.
   */
  openCacheDetailsDialog() {
    const def = this.definitions.cache[this.currentData.key];
    const placeholder = def && def.description && def.description.found ? def.description.found : '';
    const content = `<form>
      <div class="form-group">
        <label for="ta-cache-desc">Describe the cache contents (optional):</label>
        <textarea id="ta-cache-desc" name="ta-cache-desc" rows="3" style="width:100%" placeholder="${placeholder}"></textarea>
      </div>
    </form>`;
    new Dialog({
      title: 'Cache Details',
      content,
      buttons: {
        create: {
          label: 'Continue',
          callback: html => {
            this.currentData.description = html.find('#ta-cache-desc').val().trim();
            this.promptDrawTile();
          }
        },
        back: {
          label: 'Back',
          callback: () => this.openLocationDialog()
        }
      },
      default: 'create'
    }).render(true);
  }

  /**
   * Instruct the GM to draw a tile on the scene to finalise trap or cache
   * placement. A one-time hook listens for the next tile creation and
   * attaches the trap data to that tile, then spawns hint tokens.
   */
  promptDrawTile() {
    ui.notifications.info('Draw a tile to place your trap or cache.');
    // Listen for the next tile creation only once.
    const handler = async tileDoc => {
      Hooks.off('createTile', handler);
      try {
        await this.onTileCreated(tileDoc);
      } catch (err) {
        console.error('Trap Automator: error attaching trap data', err);
        ui.notifications.error('An error occurred creating the trap or cache.');
      }
    };
    Hooks.on('createTile', handler);
  }

  /**
   * Callback invoked when the GM finishes drawing a tile. Builds the trap
   * data object, stores it as a flag on the tile and spawns hint tokens
   * around the tile.
   * @param {TileDocument} tileDoc The newly created tile document
   */
  async onTileCreated(tileDoc) {
    const trapData = this.buildTrapData();
    // Prepare the macro trigger for Monk's Active Tile Triggers. Use the hardcoded
    // macro UUID provided by the GM via settings. If no custom macro has
    // been selected, fall back to the default value. Wrap the JSON argument
    // in quotes to prevent splitting on spaces. Escape double quotes inside
    // the JSON.
    const macroUuid = game.settings.get('trap-automator', 'macroId') || 'Macro.z9RXNw9fEKBIkxHW';
    const rawJson = JSON.stringify(trapData);
    const escaped = rawJson.replace(/"/g, '\\"');
    const argString = `"${escaped}"`;
    const action = {
      id: foundry.utils.randomID(),
      action: 'runmacro',
      data: {
        macroid: macroUuid,
        args: argString,
        runasgm: 'player'
      }
    };
    // Build hint strings for each difficulty based on location
    const hints = this.getHints(trapData);
    // Update tile flags to include trap data and macro trigger. Use update() so
    // both flags are written in a single call.
    try {
      await tileDoc.update({
        flags: {
          'trap-automator': { trapData },
          'monks-active-tiles': {
            trigger: 'enter',
            active: true,
            restrictedTokens: 'players',
            actions: [action]
          }
        }
      });
    } catch (err) {
      console.error('Trap Automator: Failed to update tile flags', err);
      ui.notifications.error('Trap Automator: Failed to create macro trigger. See console for details.');
    }
    // Spawn linked hint tokens around the tile.
    try {
      await this.spawnHintsAroundTile(tileDoc, hints);
    } catch (err) {
      console.error('Trap Automator: Failed to spawn hint tokens', err);
      ui.notifications.error('Trap Automator: Failed to create hint tokens. See console for details.');
    }
    ui.notifications.info('Trap or cache created. Hint tokens have been placed and the tile will now trigger the Trap Trigger macro when entered.');
  }

  /**
   * Construct a serialisable object describing the trap or cache. For traps
   * this includes the name, flavour text, save type, DC, damage and
   * success/failure texts. For caches only the name and found text are
   * included. The flavour text is normalised to a consistent pattern.
   */
  buildTrapData() {
    const type = this.currentData.type;
    const key = this.currentData.key;
    const def = this.definitions[type][key];
    const location = this.currentData.location;
    const trigger = this.currentData.trigger || '';
    const result = {
      name: def.name || key,
      type
    };
    // Normalise flavour text using the definition's description template.
    if (def.description && def.description.flavor) {
      // Clean the base description by stripping placeholder markers and
      // removing leading clauses that reference the trigger or location.
      let descPart = this.cleanFlavorText(def.description.flavor);
      // If the cleaned description begins with a sensory verb (e.g. "hear",
      // "feel", "sense", etc.), prepend "You " so the sentence reads
      // naturally. Without this, messages like "Hear a deafening rumble…"
      // would lack a subject when appended after the trigger and location.
      const sensoryVerbs = ['hear', 'feel', 'sense', 'see', 'notice', 'spot', 'detect', 'smell', 'taste', 'observe', 'perceive', 'catch'];
      const firstWord = descPart.split(/\s+/)[0]?.toLowerCase() || '';
      if (sensoryVerbs.includes(firstWord)) {
        descPart = `You ${descPart}`;
      }
      // Map location keys to phrases. Omit phrase for "other".
      const locMap = { floor: 'on the floor', wall: 'on the wall', ceiling: 'on the ceiling', other: '' };
      const locPhrase = locMap[location] || '';
      let flavour;
      if (trigger) {
        // Compose the final narrative: You <trigger> <location phrase>. <clean description>
        const prefix = `You ${trigger}${locPhrase ? ' ' + locPhrase : ''}.`;
        flavour = `${prefix} ${descPart}`.trim();
      } else {
        flavour = `${descPart}`.trim();
      }
      result.flavor = flavour;
    } else {
      result.flavor = '';
    }
    if (type === 'trap') {
      result.saveType = (this.currentData.saveType || def.defaultSave || 'dex').toLowerCase();
      // Record the actual DC used for rolls in a hidden property and omit
      // the DC field itself. By not setting result.DC the macro will
      // suppress displaying "(DC X)" in chat while still allowing
      // modules to access the value via hiddenDC if needed.
      const actualDC = this.currentData.dc || 10;
      result.hiddenDC = actualDC;
      // Do not expose DC on the top level
      // result.DC is intentionally left undefined
      result.damageFormula = this.currentData.damage || '';
      result.halfDamageOnSuccess = !!this.currentData.half;
      result.damageType = this.currentData.damageType || null;
      const effectText = this.currentData.effect ? ' ' + this.currentData.effect : '';
      result.failText = `${def.description.fail || ''}${effectText}`;
      result.successText = `${def.description.success || ''}${this.currentData.half ? ' You take half damage.' : ''}`;
    } else {
      // Cache
      result.saveType = null;
      result.DC = null;
      result.damageFormula = null;
      result.halfDamageOnSuccess = false;
      const desc = this.currentData.description || (def.description && def.description.found) || '';
      result.foundText = desc;
    }
    return result;
  }

  /**
   * Select one hint string for each difficulty level (+2, +4, +6, +10) based
   * on the chosen location. If no hints are defined for a given diff or
   * location, an empty string is used.
   * @param {Object} trapData The trap data object
   * @returns {Object} Map of diff levels to hint strings
   */
  getHints(trapData) {
    const type = trapData.type;
    const key = this.currentData.key;
    const def = this.definitions[type][key];
    const loc = this.currentData.location;
    const diffs = ['+2', '+4', '+6', '+10'];
    const hints = {};
    const locHints = def.hints && def.hints[loc];
    // If hints for the location are provided as an array of sets choose one set
    if (Array.isArray(locHints) && locHints.length) {
      const setIdx = Math.floor(Math.random() * locHints.length);
      const set = locHints[setIdx];
      for (const diff of diffs) {
        hints[diff] = set[diff] || '';
      }
    } else {
      for (const diff of diffs) {
        const options = locHints && locHints[diff];
        if (options && options.length) {
          const idx = Math.floor(Math.random() * options.length);
          hints[diff] = options[idx];
        } else {
          hints[diff] = '';
        }
      }
    }
    return hints;
  }

  /**
   * Spawn four linked hint tokens around the given tile. Each token is
   * created from an actor named "Hint +N" where N is the difficulty
   * modifier. The tokens are positioned above, right, below and left of
   * the tile with a small padding. If any actor is missing a warning is
   * shown.
   * @param {TileDocument} tileDoc The tile around which to spawn hints
   * @param {Object} hintsByDiff Map of diff levels to hint strings
   */
  async spawnHintsAroundTile(tileDoc, hintsByDiff) {
    const scene = canvas.scene;
    const grid = canvas.grid.size;
    const pad = 40;
    // Compute tile coordinates. TileDocument has x,y,width,height in px.
    const td = tileDoc;
    const spots = [
      { x: td.x + td.width / 2,      y: td.y - pad },             // top
      { x: td.x + td.width + pad,    y: td.y + td.height / 2 },   // right
      { x: td.x + td.width / 2,      y: td.y + td.height + pad }, // bottom
      { x: td.x - pad,               y: td.y + td.height / 2 }    // left
    ];
    const diffs = ['+2', '+4', '+6', '+10'];
    const createData = [];
    for (let i = 0; i < diffs.length; i++) {
      const diff = diffs[i];
      const hintText = hintsByDiff[diff];
      if (!hintText) continue;
      const actor = game.actors.getName(`Hint ${diff}`);
      if (!actor) {
        ui.notifications.warn(`Trap Automator: No actor named "Hint ${diff}" found.`);
        continue;
      }
      const proto = actor.prototypeToken?.toObject?.();
      if (!proto) {
        ui.notifications.warn(`Trap Automator: Actor "${actor.name}" has no prototypeToken defined.`);
        continue;
      }
      const tokenPixelW = (proto.width ?? 1) * grid;
      const tokenPixelH = (proto.height ?? 1) * grid;
      const spot = spots[i % spots.length];
      const data = foundry.utils.mergeObject(proto, {
        actorId: actor.id,
        actorLink: true,
        name: hintText,
        displayName: CONST.TOKEN_DISPLAY_MODES.HOVER,
        x: Math.round(spot.x - tokenPixelW / 2),
        y: Math.round(spot.y - tokenPixelH / 2),
        hidden: false
      }, { inplace: false, insertKeys: true, overwrite: true });
      delete data.actorData;
      delete data._id;
      createData.push(data);
    }
    if (createData.length) {
      await scene.createEmbeddedDocuments('Token', createData);
    }
  }
}

// Initialise the module and register the keybinding. Also expose the
// TrapAutomator instance on the game object for console access.
Hooks.once('init', () => {
  console.log('Trap Automator: init hook fired');
  // Register the world setting for custom definitions
  TrapAutomator.registerSettings();
  game.trapAutomator = new TrapAutomator();
  game.trapAutomator.registerKeybinding();
});

// When the world is ready, load built‑in definitions from the JSON file
// packaged with the module and merge any custom definitions stored in the
// world settings. Log how many traps and caches were loaded for debug.
Hooks.once('ready', async () => {
  console.log('Trap Automator: ready hook fired');
  try {
    const resp = await fetch('modules/trap-automator/definitions/builtin-defs.json');
    if (resp.ok) {
      const data = await resp.json();
      game.trapAutomator.mergeDefinitions(data);
      const trapCount = Object.keys(game.trapAutomator.definitions.trap || {}).length;
      const cacheCount = Object.keys(game.trapAutomator.definitions.cache || {}).length;
      console.log(`Trap Automator: loaded ${trapCount} traps and ${cacheCount} caches from definitions`);
    } else {
      console.error('Trap Automator: failed to load builtin definitions:', resp.statusText);
    }
  } catch (err) {
    console.error('Trap Automator: error loading definitions', err);
  }
  // Load any custom definitions stored in settings.
  try {
    const custom = game.settings.get('trap-automator', 'customDefs');
    if (custom && Object.keys(custom).length) {
      game.trapAutomator.mergeDefinitions(custom);
      console.log('Trap Automator: loaded custom definitions');
    }
  } catch (err) {
    // Ignore missing settings for first‑time install
  }
  // Initialise default trigger lists for each primary category. These lists
  // provide sensible phrases such as "step on a pressure plate" for the
  // generic category and similar thematic triggers for sci‑fi, magical,
  // natural and grimdark categories. If triggers are already defined in
  // custom definitions they will not be overwritten.
  // Initialise default triggers only if builtin definitions define traps or caches.
  // For blank/test versions with no definitions, skip populating triggers so the module
  // starts with an empty trigger list and the GM can create custom triggers. Check
  // whether there is at least one trap or cache key before invoking the defaults.
  try {
    const hasDefs = (Object.keys(game.trapAutomator.definitions.trap || {}).length > 0) || (Object.keys(game.trapAutomator.definitions.cache || {}).length > 0);
    if (hasDefs) {
      game.trapAutomator.initializeDefaultTriggers();
      console.log('Trap Automator: default triggers initialised');
    } else {
      console.log('Trap Automator: no builtin definitions found; skipping default triggers');
    }
  } catch (err) {
    console.error('Trap Automator: error initialising default triggers', err);
  }
});