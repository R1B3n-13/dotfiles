# ~/.bashrc: executed by bash(1) for non-login shells.
# Enhanced with ZSH-like features and modern styling

# If not running interactively, don't do anything
case $- in
    *i*) ;;
    *) return ;;
esac

# ═══════════════════════════════════════════════════════════════════
# HISTORY CONFIGURATION (ZSH-like)
# ═══════════════════════════════════════════════════════════════════
HISTCONTROL=ignoreboth:erasedups # Remove duplicates across sessions
HISTSIZE=10000                   # More history in memory
HISTFILESIZE=50000               # More history in file
HISTTIMEFORMAT="%F %T "          # Add timestamps to history
shopt -s histappend              # Append to history file
shopt -s histverify              # Verify history expansions
shopt -s cmdhist                 # Save multi-line commands as one entry

# Real-time history sharing (like zsh)
PROMPT_COMMAND="history -a; history -c; history -r; $PROMPT_COMMAND"

# ═══════════════════════════════════════════════════════════════════
# SHELL OPTIONS (ZSH-like behavior)
# ═══════════════════════════════════════════════════════════════════
shopt -s checkwinsize            # Update LINES and COLUMNS after each command
shopt -s autocd 2>/dev/null      # Change directory by typing dirname (if available)
shopt -s cdspell                 # Auto-correct minor spelling errors in cd
shopt -s dirspell                # Auto-correct directory spelling in completion
shopt -s globstar                # Enable ** recursive globbing
shopt -s nocaseglob              # Case-insensitive globbing
shopt -s extglob                 # Extended pattern matching

# ═══════════════════════════════════════════════════════════════════
# COLOR AND STYLING DEFINITIONS
# ═══════════════════════════════════════════════════════════════════
# ANSI system colors (color0-color15) — automatically follow terminal theme
RED='\[\e[31m\]'            LIGHT_RED='\[\e[91m\]'
GREEN='\[\e[32m\]'          LIGHT_GREEN='\[\e[92m\]'
YELLOW='\[\e[33m\]'         ORANGE='\[\e[33m\]'
BLUE='\[\e[34m\]'           LIGHT_BLUE='\[\e[94m\]'
PURPLE='\[\e[35m\]'         MAGENTA='\[\e[95m\]'
CYAN='\[\e[36m\]'           LIGHT_CYAN='\[\e[96m\]'
WHITE='\[\e[97m\]'          GRAY='\[\e[37m\]'
DARK_GRAY='\[\e[90m\]'      RESET='\[\e[0m\]'

# Nerd Font Icons
ICON_GIT=""             # Git branch
ICON_FOLDER=""          # Folder
ICON_HOME=""            # Home
ICON_ROOT="🗲"            # Root
ICON_ARROW="➜"           # Arrow
ICON_SUCCESS="✓"         # Success
ICON_FAIL="✗"            # Failure
ICON_DIRTY="󰅙"           # Git dirty
ICON_CLEAN="󰗠"           # Git clean
ICON_AHEAD=""           # Git ahead
ICON_BEHIND=""          # Git behind
ICON_PYTHON=" "         # Python env
ICON_NODE=" "           # Node env
ICON_STASH=""           # Git stash
ICON_COOL="󰱫"            # Startup emo
ICON_SSH=""             # SSH


# ═══════════════════════════════════════════════════════════════════
# ADVANCED GIT INFORMATION FUNCTION
# ═══════════════════════════════════════════════════════════════════
git_info() {
    local git_dir branch status ahead behind dirty stash

    # Check if we're in a git repository
    git_dir=$(git rev-parse --git-dir 2>/dev/null) || return

    # Get branch name
    branch=$(git symbolic-ref --short HEAD 2>/dev/null || git describe --tags --exact-match 2>/dev/null || git rev-parse --short HEAD 2>/dev/null)

    # Check if repository is dirty
    if [[ -n $(git status --porcelain 2>/dev/null) ]]; then
        dirty=" ${RED}${ICON_DIRTY} "
    else
        dirty=" ${GREEN}${ICON_CLEAN} "
    fi

    # Check for stashes
    if git rev-parse --verify refs/stash >/dev/null 2>&1; then
        stash="${YELLOW}${ICON_STASH}"
    fi

    # Check commits ahead/behind
    local ahead_behind
    ahead_behind=$(git rev-list --count --left-right @{upstream}...HEAD 2>/dev/null)
    if [[ -n "$ahead_behind" ]]; then
        behind=$(echo "$ahead_behind" | cut -f1)
        ahead=$(echo "$ahead_behind" | cut -f2)
        [[ "$ahead" -gt 0 ]] && ahead="${GREEN}${ICON_AHEAD}${ahead} " || ahead=""
        [[ "$behind" -gt 0 ]] && behind="${RED}${ICON_BEHIND}${behind} " || behind=""
    fi

    # Combine git info
    echo " ${GRAY}on ${PURPLE}${ICON_GIT}${branch}${dirty}${ahead}${behind}${stash}${RESET}"
}

# ═══════════════════════════════════════════════════════════════════
# PYTHON VIRTUAL ENVIRONMENT DETECTION
# ═══════════════════════════════════════════════════════════════════
python_env() {
    if [[ -n "$VIRTUAL_ENV" ]]; then
        local env_name=$(basename "$VIRTUAL_ENV")
        echo " ${GRAY}via ${YELLOW}${ICON_PYTHON} ${env_name}${RESET}"
    elif [[ -n "$CONDA_DEFAULT_ENV" ]]; then
        echo " ${GRAY}via ${YELLOW}${ICON_PYTHON}${WHITE}${CONDA_DEFAULT_ENV}${RESET}"
    fi
}

# ═══════════════════════════════════════════════════════════════════
# NODE ENVIRONMENT DETECTION
# ═══════════════════════════════════════════════════════════════════
node_env() {
    if [[ -f "package.json" ]] && command -v node >/dev/null 2>&1; then
        local node_version=$(node -v 2>/dev/null | sed 's/v//')
        echo " ${GRAY}via ${LIGHT_GREEN}${ICON_NODE}${WHITE}${node_version}${RESET}"
    fi
}


# ═══════════════════════════════════════════════════════════════════
# DIRECTORY SHORTENING FUNCTION
# ═══════════════════════════════════════════════════════════════════
short_pwd() {
    local pwd_length=15
    local pwd_symbol="…"
    local current_pwd=$(pwd)

    # Replace home directory with ~
    current_pwd=${current_pwd/#$HOME/\~}

    if [[ ${#current_pwd} -gt $pwd_length ]]; then
        echo "${pwd_symbol}${current_pwd:$((${#current_pwd}-$pwd_length+1))}"
    else
        echo "$current_pwd"
    fi
}

# ═══════════════════════════════════════════════════════════════════
# USER AND HOST STYLING
# ═══════════════════════════════════════════════════════════════════
user_host() {
    if [[ $EUID -eq 0 ]]; then
        echo "${RED}${ICON_ROOT} \u${RESET}${GRAY}@${RED}\h${RESET}"
    else
        if [[ -n "$SSH_CLIENT" || -n "$SSH_TTY" ]]; then
            echo "${YELLOW}${ICON_SSH} \u${RESET}${GRAY}@${ORANGE}\h${RESET}"
        else
            echo "${CYAN}\u${RESET}${GRAY}@${LIGHT_BLUE}\h${RESET}"
        fi
    fi
}

# ═══════════════════════════════════════════════════════════════════
# DIRECTORY ICON FUNCTION
# ═══════════════════════════════════════════════════════════════════
dir_icon() {
    if [[ "$PWD" == "$HOME" ]]; then
        echo "${BLUE}${ICON_HOME}"
    else
        echo "${YELLOW}${ICON_FOLDER}"
    fi
}

# ═══════════════════════════════════════════════════════════════════
# MAIN PROMPT CONSTRUCTION
# ═══════════════════════════════════════════════════════════════════
set_prompt() {
    local exit_code=$?

    # Status indicator
    local status_indicator
    if [[ $exit_code -eq 0 ]]; then
        status_indicator="${GREEN}${ICON_SUCCESS}${RESET}"
    else
        status_indicator="${RED}${ICON_FAIL} ${exit_code}${RESET}"
    fi

    # Build the prompt
    PS1="\n${GRAY}╭─${RESET}"
    PS1+=" $(user_host)"
    PS1+=" ${GRAY}in $(dir_icon) ${LIGHT_RED}$(short_pwd)${RESET}"
    PS1+="$(git_info)"
    PS1+="$(python_env)"
    PS1+="$(node_env)"
    PS1+="${timer_display}"
    PS1+="\n${GRAY}╰─${RESET} ${status_indicator} ${CYAN}${ICON_ARROW}${RESET} "

    # Window title
    echo -ne "\e]0;$(whoami)@$(hostname): $(short_pwd)\a"
}

PROMPT_COMMAND="set_prompt; $PROMPT_COMMAND"

# ═══════════════════════════════════════════════════════════════════
# ENHANCED AUTO-COMPLETION
# ═══════════════════════════════════════════════════════════════════
if ! shopt -oq posix; then
    if [[ -f /usr/share/bash-completion/bash_completion ]]; then
        . /usr/share/bash-completion/bash_completion
    elif [[ -f /etc/bash_completion ]]; then
        . /etc/bash_completion
    fi
fi

# Make completions case-insensitive
bind "set completion-ignore-case on"
bind "set completion-map-case on"
bind "set show-all-if-ambiguous on"
bind "set menu-complete-display-prefix on"

# ═══════════════════════════════════════════════════════════════════
# ZSH-LIKE FEATURES
# ═══════════════════════════════════════════════════════════════════

# Auto-suggestions using history (closest to zsh autosuggestions)
bind '"\e[A": history-search-backward'  # Up arrow
bind '"\e[B": history-search-forward'   # Down arrow
bind '"\eOA": history-search-backward'  # Up arrow (alternative)
bind '"\eOB": history-search-forward'   # Down arrow (alternative)

# Substring history search with Ctrl+R enhancement
bind '"\C-r": reverse-search-history'
bind '"\C-s": forward-search-history'

# Menu completion (like zsh menu select)
bind 'TAB: menu-complete'
bind '"\e[Z": menu-complete-backward'  # Shift+Tab

# Quick directory navigation
bind -x '"\C-f": "cd \$(find . -type d | fzf 2>/dev/null || echo .)"'

# ═══════════════════════════════════════════════════════════════════
# MODERN ALIASES (ZSH-STYLE)
# ═══════════════════════════════════════════════════════════════════

# Enhanced ls with colors and icons (if exa/eza is available)
if command -v eza >/dev/null 2>&1; then
    alias ls='eza --icons --group-directories-first'
    alias ll='eza -la --icons --group-directories-first'
    alias la='eza -a --icons --group-directories-first'
    alias lt='eza --tree --icons --group-directories-first'
elif command -v exa >/dev/null 2>&1; then
    alias ls='exa --icons --group-directories-first'
    alias ll='exa -la --icons --group-directories-first'
    alias la='exa -a --icons --group-directories-first'
    alias lt='exa --tree --icons --group-directories-first'
else
    # Fallback to regular ls with colors
    alias ls='ls --color=auto --group-directories-first'
    alias ll='ls -alF --color=auto --group-directories-first'
    alias la='ls -A --color=auto --group-directories-first'
fi

# Enhanced grep with colors
alias grep='grep --color=auto'
alias fgrep='fgrep --color=auto'
alias egrep='egrep --color=auto'

# Modern replacements
command -v batcat >/dev/null 2>&1 && alias cat='batcat --style=auto'
command -v fdfind >/dev/null 2>&1 && alias find='fdfind'
command -v rg >/dev/null 2>&1 && alias grep='rg'
command -v htop >/dev/null 2>&1 && alias top='htop'
command -v prettyping >/dev/null 2>&1 && alias ping='prettyping'

# Git aliases (oh-my-zsh style)
alias ga='git add'
alias gaa='git add .'
alias gc='git commit'
alias gcm='git commit -m'
alias gca='git commit --amend'
alias gco='git checkout'
alias gcb='git checkout -b'
alias gst='git status'
alias gd='git diff'
alias gl='git log --oneline --graph --decorate'
alias gp='git push'
alias gpl='git pull'
alias gpr='git pull --rebase'
alias gf='git fetch'

# Directory navigation
alias ..='cd ..'
alias ...='cd ../..'
alias ....='cd ../../..'
alias .....='cd ../../../..'
alias ~='cd ~'
alias -- -='cd -'

# Modern utilities
alias l='ls -CF'
alias la='ls -A'
alias ll='ls -alF'
alias df='df -h'
alias du='du -h'
alias free='free -h'
alias mkdir='mkdir -pv'
alias mv='mv -i'
alias cp='cp -i'
alias rm='rm -i'

# Network and system
alias ports='netstat -tulanp'
alias myip='curl -s ipinfo.io/ip'
alias weather='curl -s wttr.in'

# Fun aliases
alias plz='sudo'
alias c='clear'
alias e='exit'
alias h='history'
alias j='jobs'

# Other aliases
# alias nv='nvim'
alias nv='snap run nvim'

# Load custom aliases if they exist
[[ -f ~/.bash_aliases ]] && . ~/.bash_aliases

# ═══════════════════════════════════════════════════════════════════
# EXTRA FEATURES
# ═══════════════════════════════════════════════════════════════════

# Auto-correct typos in cd commands
shopt -s cdspell

# Enable advanced pattern matching
shopt -s extglob

# Make less more friendly for non-text input files
[[ -x /usr/bin/lesspipe ]] && eval "$(SHELL=/bin/sh lesspipe)"

# Set up dircolors if available
if [[ -x /usr/bin/dircolors ]]; then
    test -r ~/.dircolors && eval "$(dircolors -b ~/.dircolors)" || eval "$(dircolors -b)"
fi

# Source local customizations
[[ -f ~/.bashrc.local ]] && . ~/.bashrc.local

echo "${ICON_COOL} I'm not lazy, I'm just in energy-saving mode."

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"  # This loads nvm
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"  # This loads nvm bash_completion


export PATH=$PATH:/usr/local/go/bin
