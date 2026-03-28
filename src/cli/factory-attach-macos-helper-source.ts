export const FACTORY_ATTACH_MACOS_HELPER_SOURCE = String.raw`
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/select.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
#include <util.h>

static int master_fd = -1;
static pid_t child_pid = -1;
static volatile sig_atomic_t terminate_requested = 0;

static ssize_t write_all(int fd, const char *buffer, size_t length) {
  size_t written = 0;
  while (written < length) {
    ssize_t result = write(fd, buffer + written, length - written);
    if (result == -1) {
      if (errno == EINTR) {
        continue;
      }
      return -1;
    }
    written += (size_t)result;
  }
  return (ssize_t)written;
}

static void sync_window_size(void) {
  if (master_fd == -1) {
    return;
  }

  int tty_fd = open("/dev/tty", O_RDONLY);
  if (tty_fd == -1) {
    return;
  }

  struct winsize window_size;
  if (ioctl(tty_fd, TIOCGWINSZ, &window_size) == 0) {
    (void)ioctl(master_fd, TIOCSWINSZ, &window_size);
  }

  (void)close(tty_fd);
}

static void on_resize_signal(int signal_number) {
  int saved_errno = errno;
  (void)signal_number;
  sync_window_size();
  errno = saved_errno;
}

static void on_terminate_signal(int signal_number) {
  int saved_errno = errno;
  (void)signal_number;
  terminate_requested = 1;
  if (child_pid > 0) {
    (void)kill(child_pid, SIGTERM);
  }
  errno = saved_errno;
}

static int wait_for_child_exit(void) {
  int status = 0;
  while (waitpid(child_pid, &status, 0) == -1) {
    if (errno == EINTR) {
      continue;
    }
    perror("waitpid");
    return 1;
  }

  if (WIFEXITED(status)) {
    return WEXITSTATUS(status);
  }
  if (WIFSIGNALED(status)) {
    return 128 + WTERMSIG(status);
  }
  return 1;
}

int main(int argc, char **argv) {
  if (argc != 2) {
    fprintf(stderr, "usage: %s <screen-session-id>\n", argv[0]);
    return 64;
  }

  int slave_fd = -1;
  struct winsize window_size;
  struct winsize *window_size_ptr = NULL;
  int tty_fd = open("/dev/tty", O_RDONLY);
  if (tty_fd != -1) {
    if (ioctl(tty_fd, TIOCGWINSZ, &window_size) == 0) {
      window_size_ptr = &window_size;
    }
    (void)close(tty_fd);
  }

  if (openpty(&master_fd, &slave_fd, NULL, NULL, window_size_ptr) == -1) {
    perror("openpty");
    return 1;
  }

  child_pid = fork();
  if (child_pid == -1) {
    perror("fork");
    return 1;
  }

  if (child_pid == 0) {
    (void)close(master_fd);
    if (login_tty(slave_fd) == -1) {
      perror("login_tty");
      _exit(1);
    }
    execlp("screen", "screen", "-x", argv[1], (char *)NULL);
    perror("execlp");
    _exit(errno == ENOENT ? 127 : 1);
  }

  (void)close(slave_fd);

  struct sigaction resize_action;
  memset(&resize_action, 0, sizeof(resize_action));
  resize_action.sa_handler = on_resize_signal;
  sigemptyset(&resize_action.sa_mask);
  resize_action.sa_flags = SA_RESTART;
  (void)sigaction(SIGWINCH, &resize_action, NULL);

  struct sigaction terminate_action;
  memset(&terminate_action, 0, sizeof(terminate_action));
  terminate_action.sa_handler = on_terminate_signal;
  sigemptyset(&terminate_action.sa_mask);
  terminate_action.sa_flags = 0;
  (void)sigaction(SIGINT, &terminate_action, NULL);
  (void)sigaction(SIGTERM, &terminate_action, NULL);
  (void)sigaction(SIGHUP, &terminate_action, NULL);

  sync_window_size();

  bool stdin_open = true;
  char buffer[4096];

  while (!terminate_requested) {
    fd_set read_set;
    FD_ZERO(&read_set);
    FD_SET(master_fd, &read_set);
    int max_fd = master_fd;
    if (stdin_open) {
      FD_SET(STDIN_FILENO, &read_set);
      if (STDIN_FILENO > max_fd) {
        max_fd = STDIN_FILENO;
      }
    }

    int ready = select(max_fd + 1, &read_set, NULL, NULL, NULL);
    if (ready == -1) {
      if (errno == EINTR) {
        continue;
      }
      perror("select");
      terminate_requested = 1;
      if (child_pid > 0) {
        (void)kill(child_pid, SIGTERM);
      }
      break;
    }

    if (stdin_open && FD_ISSET(STDIN_FILENO, &read_set)) {
      ssize_t bytes_read = read(STDIN_FILENO, buffer, sizeof(buffer));
      if (bytes_read == 0) {
        stdin_open = false;
      } else if (bytes_read == -1) {
        if (errno != EINTR) {
          perror("read");
          terminate_requested = 1;
          if (child_pid > 0) {
            (void)kill(child_pid, SIGTERM);
          }
          break;
        }
      } else if (write_all(master_fd, buffer, (size_t)bytes_read) == -1) {
        perror("write");
        terminate_requested = 1;
        if (child_pid > 0) {
          (void)kill(child_pid, SIGTERM);
        }
        break;
      }
    }

    if (FD_ISSET(master_fd, &read_set)) {
      ssize_t bytes_read = read(master_fd, buffer, sizeof(buffer));
      if (bytes_read == 0) {
        break;
      }
      if (bytes_read == -1) {
        if (errno == EINTR) {
          continue;
        }
        if (errno == EIO) {
          break;
        }
        perror("read");
        terminate_requested = 1;
        if (child_pid > 0) {
          (void)kill(child_pid, SIGTERM);
        }
        break;
      }
      if (write_all(STDOUT_FILENO, buffer, (size_t)bytes_read) == -1) {
        perror("write");
        terminate_requested = 1;
        if (child_pid > 0) {
          (void)kill(child_pid, SIGTERM);
        }
        break;
      }
    }
  }

  if (master_fd != -1) {
    (void)close(master_fd);
  }

  return wait_for_child_exit();
}
`;
