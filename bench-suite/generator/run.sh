#!/usr/bin/env bash
#
# Оркестратор бизнес-бенчмарков Гипер Базы. Методика — ../BENCHMARK_PLAN.md
#
# Роли: этот скрипт запускается НА ГЕНЕРАТОРЕ (локальная машина) и по ssh
# управляет узлом под тестом. Генератор и узел обязаны быть разными машинами:
# сборка пакета впятеро дороже его приёма, и на одной машине они дерутся за ядра.
#
#   ./run.sh prep              подготовить узел (остановить лишнее, поднять чистую базу, отвязать от чужих мастеров)
#   ./run.sh check             проверить, что узел готов к замеру
#   ./run.sh baseline [сек]    снять фоновый шум простаивающего узла
#   ./run.sh s2                потолок приёма: ступени темпа до насыщения
#   ./run.sh s3                веер: один писатель, растущее число читателей
#   ./run.sh s4                офис: N клиентов, у каждого свой ленд
#   ./run.sh restore           вернуть узел в исходное состояние
#
# Каждый прогон складывается в results/<дата>-<сценарий>/ вместе с метриками
# узла и manifest.txt, в котором записано, на чём именно это мерялось.

set -euo pipefail

cd "$( dirname "${BASH_SOURCE[0]}" )"

# ── Конфигурация ──────────────────────────────────────────────────────────────

SUT_SSH="${SUT_SSH:-user@91.188.212.151}"
SUT_HOST="${SUT_HOST:-91.188.212.151}"
SUT_PORT="${SUT_PORT:-9090}"

# Компоуз базы на узле и имя её контейнера.
BAZA_DIR="${BAZA_DIR:-/home/giper/baza/app/run}"
BAZA_NAME="${BAZA_NAME:-run-baza-1}"

# Публичный мастер из вшитого в бандл Seed. Пока связь с ним жива, в замер
# попадает чужой трафик и чужие ленды — на время тестов режем.
FOREIGN_MASTER_IP="${FOREIGN_MASTER_IP:-91.219.148.98}"

# Контейнеры, которые НЕ трогаем при очистке узла. По умолчанию пусто — гасим
# всё, включая caddy: замер идёт по прямому http на 9090, TLS в нём не участвует.
# Чтобы мерить «как в проде», через caddy: KEEP_RUNNING=run-caddy-1 SUT_PORT=443.
KEEP_RUNNING="${KEEP_RUNNING:-}"

# Генератор: собранный модуль $giper_bench.
GEN="${GEN:-./-/node.js}"

STATE_DIR="state"
RESULTS_DIR="results"

# ── Утилиты ───────────────────────────────────────────────────────────────────

say() { printf '\033[36m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*"; }
die() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

# Прогон делает десятки обращений к узлу, и sshd на нём начинает рвать частые
# подключения. Держим одно мультиплексированное соединение на весь прогон:
# заодно снимается стоимость рукопожатия из измерительной петли.
SSH_CTL="${TMPDIR:-/tmp}/bench-ssh-%h-%p-%r"
SSH_OPTS=(
	-o BatchMode=yes
	-o ConnectTimeout=15
	-o ControlMaster=auto
	-o "ControlPath=$SSH_CTL"
	-o ControlPersist=10m
	-o ServerAliveInterval=30
)

sut() { ssh "${SSH_OPTS[@]}" "$SUT_SSH" "$@"; }

confirm() {
	[ "${FORCE:-0}" = "1" ] && return 0
	printf '\033[33m%s [y/N] \033[0m' "$1"
	read -r answer
	[ "$answer" = "y" ] || [ "$answer" = "Y" ]
}

gen_ip() {
	curl -s --max-time 10 https://api.ipify.org || die 'Не удалось определить внешний IP генератора'
}

# ── prep: подготовка узла ─────────────────────────────────────────────────────

cmd_prep() {

	mkdir -p "$STATE_DIR"

	say '── Что сейчас работает на узле ──'
	local running
	running=$( sut 'docker ps --format "{{.Names}}"' )
	echo "$running"

	# Пустой KEEP_RUNNING означает «гасим всё, кроме самой базы». Собираем
	# паттерн явно: пустая альтернатива в -E матчит любую строку и вычистила бы
	# список целиком, оставив узел нетронутым.
	local keep_pattern="$BAZA_NAME"
	[ -n "$KEEP_RUNNING" ] && keep_pattern="$( echo "$KEEP_RUNNING" | tr ' ' '|' )|$BAZA_NAME"

	local to_stop
	to_stop=$( echo "$running" | grep -v -x -E "$keep_pattern" || true )

	if [ -n "$to_stop" ]; then
		echo
		warn 'Будут остановлены на время тестов (в restore поднимутся обратно):'
		echo "$to_stop"
		confirm 'Останавливаем?' || die 'Отменено'

		echo "$to_stop" > "$STATE_DIR/containers_stopped.txt"
		# shellcheck disable=SC2086
		sut "docker stop $( echo $to_stop | tr '\n' ' ' )" > /dev/null
		say "Остановлено контейнеров: $( echo "$to_stop" | wc -l | tr -d ' ' )"
	else
		: > "$STATE_DIR/containers_stopped.txt"
		say 'Посторонних контейнеров нет'
	fi

	# Watchtower обновляет образы посреди прогона и обесценивает результат —
	# он в списке остановленных выше, но проверим отдельно, что его нет.
	if sut 'docker ps --format "{{.Names}}"' | grep -qi watchtower; then
		die 'watchtower всё ещё работает — он перезапустит базу посреди прогона'
	fi

	say '── Чистый том базы ──'
	local vol_size
	vol_size=$( sut "sudo -n du -sb /var/lib/docker/volumes/run_baza_public/_data 2>/dev/null | cut -f1" || echo 0 )
	if [ "${vol_size:-0}" -gt 100000 ]; then
		warn "В томе базы уже лежит $(( vol_size / 1024 )) КБ данных."
		if confirm 'Переименовать старый том и начать с пустого?'; then
			# Одного mv мало: docker продолжает считать том существующим и при
			# старте падает на несуществующем каталоге. Убираем и запись о томе —
			# compose создаст его заново, уже пустым.
			sut "cd $BAZA_DIR && docker compose rm -fs baza >/dev/null 2>&1 || true
				sudo -n mv /var/lib/docker/volumes/run_baza_public /var/lib/docker/volumes/run_baza_public_pre_bench_\$( date +%Y%m%d%H%M )
				docker volume rm run_baza_public >/dev/null 2>&1 || true"
			echo 'renamed' > "$STATE_DIR/volume_renamed.txt"
			say 'Старый том отложен, база стартует с нуля'
		fi
	fi

	say '── Отвязка от чужого мастера ──'
	# Адрес мастера вшит в бандл (Seed), поэтому проще всего закрыть маршрут.
	# Для этапа с двумя своими узлами это правило снимается и вместо него
	# собирается свой Seed — см. раздел 4 плана.
	sut "sudo -n iptables -C OUTPUT -d $FOREIGN_MASTER_IP -j REJECT 2>/dev/null \
		|| sudo -n iptables -I OUTPUT 1 -d $FOREIGN_MASTER_IP -j REJECT"
	say "Исходящие к $FOREIGN_MASTER_IP закрыты"

	say '── Доступ генератора к узлу ──'
	# Ограничить порт одним IP не выходит: генератор сидит за VPN, и внешний
	# адрес меняется между запросами. Открываем порт целиком на время прогона —
	# база на нём пустая, тестовая и отвязана от чужих мастеров, а restore
	# правило снимает. Свой IP всё равно фиксируем в manifest прогона.
	gen_ip > "$STATE_DIR/gen_ip.txt" || true
	sut "sudo -n ufw allow $SUT_PORT/tcp" > /dev/null
	echo "open" > "$STATE_DIR/port_opened.txt"
	say "Порт $SUT_PORT открыт (генератор виден как $( cat "$STATE_DIR/gen_ip.txt" ))"

	say '── Запуск базы ──'
	sut "cd $BAZA_DIR && docker compose up -d baza" > /dev/null
	sleep 5

	cmd_check
}

# ── check: готовность узла ────────────────────────────────────────────────────

cmd_check() {

	local ok=1

	local status
	status=$( sut "docker inspect -f '{{.State.Status}} {{.RestartCount}}' $BAZA_NAME" 2>/dev/null || echo 'absent' )
	say "Контейнер базы: $status"
	[ "${status%% *}" = "running" ] || { warn 'База не запущена'; ok=0; }

	# Флаг логирования глушит сбор метрик целиком: в stat.tick() стоит ранний
	# выход «Stat disabled due logging». Проверяем ДО прогона, а не после.
	local args
	args=$( sut "docker inspect -f '{{json .Config.Entrypoint}} {{json .Config.Cmd}}' $BAZA_NAME" 2>/dev/null || echo '' )
	if echo "$args" | grep -q '"giper_baza_log"'; then
		warn "База запущена с флагом giper_baza_log — встроенная статистика собираться НЕ будет"
		ok=0
	else
		say 'Флага giper_baza_log нет, статистика собирается'
	fi

	# Связь с чужим мастером: в логах при подключении печатается его адрес.
	local foreign
	foreign=$( sut "docker logs --since 2m $BAZA_NAME 2>&1 | grep -c 'ip.giper.dev' || true" )
	if [ "${foreign:-0}" -gt 0 ]; then
		warn "В свежих логах есть обращения к внешнему мастеру ($foreign строк) — замер будет грязным"
		sut "docker logs --since 2m $BAZA_NAME 2>&1 | grep 'ip.giper.dev' | tail -3" || true
		ok=0
	else
		say 'Обращений к внешним мастерам в логах нет'
	fi

	# Порт: голый GET / база не обслуживает, поэтому проверяем именно факт
	# установки TCP-соединения, а не код ответа.
	if nc -z -G 5 "$SUT_HOST" "$SUT_PORT" 2>/dev/null; then
		say "Порт $SUT_PORT доступен с генератора"
	else
		warn "Порт $SUT_PORT недоступен — проверь ufw и что prep отработал"
		ok=0
	fi

	local load
	load=$( sut "cat /proc/loadavg | cut -d' ' -f1-3" )
	say "Load average узла: $load"

	[ "$ok" = "1" ] && say 'Узел готов к замеру' || warn 'Узел к замеру НЕ готов'
	return 0
}

# ── Сбор метрик с узла ────────────────────────────────────────────────────────

# Пишет CSV раз в секунду прямо из /proc: на узле нет ни sysstat, ни jq,
# а ставить их — значит менять узел, который мы меряем.
metrics_start() {
	local out="$1"
	# Маркер в аргументах нужен, чтобы потом найти цикл в ps: сам по себе он
	# виден как безымянный `bash -s` и pkill его не отличит от чужих.
	sut "bash -s bench_metrics_marker" > "$out" <<-'REMOTE' &
		set -e
		pid=$( docker inspect -f '{{.State.Pid}}' "${BAZA_NAME:-run-baza-1}" 2>/dev/null || echo 0 )
		clk=$( getconf CLK_TCK )
		disk=$( lsblk -no pkname "$( findmnt -no SOURCE / )" 2>/dev/null | head -1 )
		disk=${disk:-vda}
		echo "ts,cpu_user_s,cpu_sys_s,rss_mb,threads,sock_est,disk_read_mb,disk_write_mb,load1,mem_free_mb"
		while true; do
			now=$( date +%s )
			if [ "$pid" != "0" ] && [ -r "/proc/$pid/stat" ]; then
				set -- $( cut -d' ' -f14,15,20,24 "/proc/$pid/stat" 2>/dev/null || echo "0 0 0 0" )
				utime=$1; stime=$2; threads=$3; rss_pages=$4
			else
				utime=0; stime=0; threads=0; rss_pages=0
			fi
			ds=$( grep " $disk " /proc/diskstats | head -1 || echo "" )
			rd=$( echo "$ds" | awk '{print $6}' ); wr=$( echo "$ds" | awk '{print $10}' )
			est=$( ss -tn state established 2>/dev/null | grep -c ":9090" || true )
			load1=$( cut -d' ' -f1 /proc/loadavg )
			memfree=$( awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo )
			echo "$now,$( echo "$utime $clk" | awk '{printf "%.2f", $1/$2}' ),$( echo "$stime $clk" | awk '{printf "%.2f", $1/$2}' ),$(( rss_pages * 4096 / 1048576 )),$threads,${est:-0},$( echo "${rd:-0}" | awk '{printf "%.1f", $1*512/1048576}' ),$( echo "${wr:-0}" | awk '{printf "%.1f", $1*512/1048576}' ),$load1,$memfree"
			sleep 1
		done
	REMOTE
	echo $! > "$STATE_DIR/metrics.pid"
}

metrics_stop() {
	[ -f "$STATE_DIR/metrics.pid" ] || return 0
	kill "$( cat "$STATE_DIR/metrics.pid" )" 2>/dev/null || true
	rm -f "$STATE_DIR/metrics.pid"
	# ssh-сессия умерла, но цикл на узле мог пережить её: он бы продолжил
	# писать в CSV и тикать процессором во время следующей точки замера.
	sut "pkill -f bench_metrics_marker 2>/dev/null || true" > /dev/null 2>&1 || true
}

# Готовит папку прогона и manifest: без него через неделю невозможно понять,
# на какой версии и при каком фоне получены цифры.
run_dir() {
	local name="$1"
	local dir="$RESULTS_DIR/$( date +%Y%m%d-%H%M )-$name"
	mkdir -p "$dir"
	{
		echo "scenario: $name"
		echo "date: $( date -u +%Y-%m-%dT%H:%M:%SZ )"
		echo "sut: $SUT_SSH"
		echo "generator_ip: $( cat "$STATE_DIR/gen_ip.txt" 2>/dev/null || echo unknown )"
		echo "baza_image: $( sut "docker inspect -f '{{.Config.Image}}' $BAZA_NAME" 2>/dev/null || echo unknown )"
		echo "baza_commit: $( cd ../baza 2>/dev/null && git rev-parse --short HEAD 2>/dev/null || echo unknown )"
		echo "baza_dirty: $( cd ../baza 2>/dev/null && [ -n "$( git status --porcelain )" ] && echo yes || echo no )"
		echo "node_local: $( node -v )"
		echo "sut_cores: $( sut nproc )"
		echo "sut_containers: $( sut 'docker ps --format "{{.Names}}"' | tr '\n' ' ' )"
	} > "$dir/manifest.txt"
	echo "$dir"
}

# Прогон одной точки: генератор локально, метрики с узла параллельно.
measure() {
	local dir="$1" label="$2"; shift 2

	say "  → $label"
	metrics_start "$dir/$label.metrics.csv"
	# Порт 9090 отдаёт голый http, TLS на нём нет — yard сам заменит схему на ws.
	# Прогон «как в проде», через caddy и TLS, делается отдельно: SUT_PORT=443.
	node "$GEN" master="http://$SUT_HOST:$SUT_PORT/" "$@" out="$dir/$label.ndjson" \
		2>&1 | tee "$dir/$label.log" || warn "  точка $label завершилась с ошибкой"
	metrics_stop

	# Пауза между ступенями: дать очередям рассосаться, иначе следующая
	# ступень стартует с хвостом предыдущей.
	sleep 30
}

# ── Сценарии ──────────────────────────────────────────────────────────────────

cmd_baseline() {
	local secs="${1:-600}"
	local dir; dir=$( run_dir baseline )
	say "Снимаю фоновый шум простаивающего узла: ${secs}с → $dir"
	metrics_start "$dir/idle.metrics.csv"
	sleep "$secs"
	metrics_stop
	say "Готово: $dir/idle.metrics.csv"
}

# S2 — потолок приёма. Ступени темпа, ищем точку, где задержка перестаёт
# держаться в пороге. Прогрев отдельной точкой, его результат отбрасывается.
cmd_s2() {
	local dir; dir=$( run_dir s2-ingest )
	say "S2 · потолок приёма → $dir"
	measure "$dir" warmup rate=25 duration=60
	rm -f "$dir/warmup.ndjson"
	for rate in 25 50 100 200 400 800; do
		measure "$dir" "rate-$rate" rate="$rate" duration=60
	done
	say "Готово. Ищи максимальный rate, где p95 ≤ 200 мс: $dir"
}

# S3 — веер. Темп писателя заведомо ниже потолка, растёт только число
# читателей: меряем цену рассылки, а не приёма.
cmd_s3() {
	local dir; dir=$( run_dir s3-fanout )
	say "S3 · веер → $dir"
	measure "$dir" warmup rate=10 readers=1 duration=60
	rm -f "$dir/warmup.ndjson"
	for readers in 1 2 5 10 25 50 100; do
		measure "$dir" "readers-$readers" rate=10 readers="$readers" duration=60
	done
	say "Готово. Строй p95 как функцию числа читателей: $dir"
}

# S4 — офис: у каждого клиента свой ленд, темп реалистичной правки текста.
# Отсюда берётся цифра «пользователей на узел» для экономики.
cmd_s4() {
	local dir; dir=$( run_dir s4-office )
	say "S4 · офис → $dir"
	measure "$dir" warmup lands=10 rate=0.5 duration=60
	rm -f "$dir/warmup.ndjson"
	for lands in 10 25 50 100; do
		measure "$dir" "lands-$lands" lands="$lands" rate=0.5 duration=60
	done
	say "Готово. Максимальный lands при p95 ≤ 3с — это пользователи на узел: $dir"
}

# ── restore ───────────────────────────────────────────────────────────────────

cmd_restore() {

	metrics_stop

	say '── Снимаю правила, поставленные ради тестов ──'

	sut "sudo -n iptables -D OUTPUT -d $FOREIGN_MASTER_IP -j REJECT 2>/dev/null || true"
	say "Маршрут к $FOREIGN_MASTER_IP открыт обратно"

	if [ -f "$STATE_DIR/port_opened.txt" ]; then
		sut "sudo -n ufw delete allow $SUT_PORT/tcp" > /dev/null 2>&1 || true
		rm -f "$STATE_DIR/port_opened.txt"
		say "Порт $SUT_PORT закрыт"
	fi
	# Подчищаем и правило по конкретному IP, если оно осталось от прошлых версий.
	if [ -s "$STATE_DIR/gen_ip.txt" ]; then
		local ip; ip=$( cat "$STATE_DIR/gen_ip.txt" )
		sut "sudo -n ufw delete allow from $ip to any port $SUT_PORT proto tcp" > /dev/null 2>&1 || true
	fi

	if [ -s "$STATE_DIR/containers_stopped.txt" ]; then
		local list; list=$( tr '\n' ' ' < "$STATE_DIR/containers_stopped.txt" )
		# shellcheck disable=SC2086
		sut "docker start $list" > /dev/null
		say "Подняты обратно: $list"
		: > "$STATE_DIR/containers_stopped.txt"
	fi

	if [ -f "$STATE_DIR/volume_renamed.txt" ]; then
		warn 'Старый том базы был отложен под именем run_baza_public_pre_bench_*.'
		warn 'Если он нужен — верни его вручную, скрипт этого не делает намеренно.'
		rm -f "$STATE_DIR/volume_renamed.txt"
	fi

	say '── Состояние узла ──'
	sut 'docker ps --format "{{.Names}}|{{.Status}}"'
}

# ── Точка входа ───────────────────────────────────────────────────────────────

case "${1:-}" in
	prep) cmd_prep ;;
	check) cmd_check ;;
	baseline) shift; cmd_baseline "$@" ;;
	s2) cmd_s2 ;;
	s3) cmd_s3 ;;
	s4) cmd_s4 ;;
	restore) cmd_restore ;;
	*)
		sed -n '3,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
		exit 1
		;;
esac
