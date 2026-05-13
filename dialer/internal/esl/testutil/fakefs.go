package testutil

import (
	"bufio"
	"fmt"
	"net"
	"strings"
	"sync"
	"testing"
)

// FakeFS is a minimal TCP server that speaks the ESL inbound protocol.
// It handles:
//   - Auth challenge/response
//   - `events plain ...` command → "+OK event listener enabled plain"
//   - `bgapi originate ...` with Job-UUID header → "+OK Job-UUID: <id>"
//   - `api ...` commands → "+OK"
// It can inject events via SendEvent.
//
// FakeFS is NOT thread-safe for setup (call methods before dialling);
// it IS safe for concurrent event injection while a client is connected.
type FakeFS struct {
	Password string
	t        testing.TB
	ln       net.Listener
	mu       sync.Mutex
	conns    []net.Conn
	closed   bool
}

// NewFakeFS starts a FakeFS on a random loopback port.
func NewFakeFS(t testing.TB, password string) *FakeFS {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("FakeFS: listen: %v", err)
	}
	fs := &FakeFS{
		Password: password,
		t:        t,
		ln:       ln,
	}
	go fs.serve()
	t.Cleanup(func() { fs.Close() })
	return fs
}

// Addr returns the "host:port" address the fake FS is listening on.
func (f *FakeFS) Addr() string { return f.ln.Addr().String() }

// Close shuts down the fake FS.
func (f *FakeFS) Close() {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.closed {
		f.closed = true
		_ = f.ln.Close()
		for _, c := range f.conns {
			_ = c.Close()
		}
	}
}

// SendEvent injects a raw ESL event string to all connected clients.
func (f *FakeFS) SendEvent(event string) {
	f.mu.Lock()
	conns := make([]net.Conn, len(f.conns))
	copy(conns, f.conns)
	f.mu.Unlock()

	for _, c := range conns {
		fmt.Fprintf(c, "Content-Type: text/event-plain\r\nContent-Length: %d\r\n\r\n%s",
			len(event), event)
	}
}

func (f *FakeFS) serve() {
	for {
		conn, err := f.ln.Accept()
		if err != nil {
			return
		}
		f.mu.Lock()
		f.conns = append(f.conns, conn)
		f.mu.Unlock()
		go f.handleConn(conn)
	}
}

func (f *FakeFS) handleConn(conn net.Conn) {
	defer conn.Close()

	// Step 1: send auth challenge.
	fmt.Fprint(conn, "Content-Type: auth/request\r\n\r\n")

	scanner := bufio.NewScanner(conn)
	var lines []string
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			// End of command (blank line = end of headers).
			f.handleCommand(conn, lines)
			lines = nil
		} else {
			lines = append(lines, line)
		}
	}
}

func (f *FakeFS) handleCommand(conn net.Conn, lines []string) {
	if len(lines) == 0 {
		return
	}
	head := lines[0]

	switch {
	case strings.HasPrefix(head, "auth ") || head == "auth":
		// Extract password from "auth ClueCon" or "Auth-Password: X" style.
		pwd := strings.TrimPrefix(head, "auth ")
		// Also check header style.
		for _, l := range lines {
			if strings.HasPrefix(l, "Auth-Password:") {
				pwd = strings.TrimSpace(strings.TrimPrefix(l, "Auth-Password:"))
			}
		}
		_ = pwd // accept any password in tests
		fmt.Fprint(conn, "Content-Type: command/reply\r\nReply-Text: +OK accepted\r\n\r\n")

	case strings.HasPrefix(head, "events "):
		fmt.Fprint(conn, "Content-Type: command/reply\r\nReply-Text: +OK event listener enabled plain\r\n\r\n")

	case strings.HasPrefix(head, "bgapi "):
		// Extract Job-UUID from headers.
		jobUUID := ""
		for _, l := range lines[1:] {
			if strings.HasPrefix(l, "Job-UUID:") {
				jobUUID = strings.TrimSpace(strings.TrimPrefix(l, "Job-UUID:"))
			}
		}
		fmt.Fprintf(conn, "Content-Type: command/reply\r\nReply-Text: +OK Job-UUID: %s\r\n\r\n", jobUUID)
		// Send BACKGROUND_JOB result after a short delay.
		go func() {
			body := "+OK " + jobUUID
			event := fmt.Sprintf("Event-Name: BACKGROUND_JOB\r\nJob-Uuid: %s\r\nContent-Length: %d\r\n\r\n%s",
				jobUUID, len(body), body)
			fmt.Fprintf(conn, "Content-Type: text/event-plain\r\nContent-Length: %d\r\n\r\n%s",
				len(event), event)
		}()

	case strings.HasPrefix(head, "api "):
		cmd := strings.TrimPrefix(head, "api ")
		if strings.HasPrefix(cmd, "show channels") {
			body := `{"rowCount":0,"rows":[]}`
			fmt.Fprintf(conn, "Content-Type: api/response\r\nContent-Length: %d\r\n\r\n%s", len(body), body)
		} else {
			fmt.Fprint(conn, "Content-Type: api/response\r\nContent-Length: 3\r\n\r\n+OK")
		}

	case head == "exit":
		fmt.Fprint(conn, "Content-Type: text/disconnect-notice\r\nContent-Disposition: disconnect\r\n\r\nBye-Bye\r\n")

	default:
		fmt.Fprint(conn, "Content-Type: command/reply\r\nReply-Text: +OK\r\n\r\n")
	}
}
